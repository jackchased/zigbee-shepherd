/* jshint node: true */
'use strict';

var EventEmitter = require('events'),
    util = require('util'),
    _ = require('lodash'),
    znp = require('cc-znp'),
    zcl = require('zcl-packet'),
    Q = require('q'),
    ZDEF = require('zstack-id'),
    Coordpoint = require('./coordpoint.js'),
    Zdo = require('./zdo'),
    bridge = require('./event_bridge.js'),
    querie = require('./querie'),
    afSender = require('./af_sender');

// CONSTANTS
var nvParams = require('./config/nv_start_options.js');
var AREQ_TIMEOUT = 30;  // seconds

// [TODO] flow control
function Controller(shepherd, cfg) {    // cfg is serial port config
    EventEmitter.call(this);

    var self = this,
        seqNum = 0,
        transId = 0,
        permitJoinTime = 0;

    this._shepherd = shepherd;
    this._coord = null;
    this._zdo = new Zdo(this);
    this._znp = znp;    // use init() to start, then fill up _coord, and register delegators
    this._cfg = cfg;
    this.querie = querie(this);

    this._net = {
        state: null,            // ZDEF.COMMON.DEV_STATES
        channel: null,
        panId: null,
        extPanId: null,
        ieeeAddr: null,
        nwkAddr: 0,
        permitRemainingTime: this.getPermitJoinTime(),
        numPendingAttribs: 0
    };

    this._delegators = [];  // [TODO] move to init()

    /*********************************************************************/
    /*** Facility                                                      ***/
    /*********************************************************************/
    this._areqCallbacks = {};
    this._areqTimeouts = {};

    /*********************************************************************/
    /*** Privileged Methods                                            ***/
    /*********************************************************************/
    this.nextSeqNum = function () {     // zcl sequence number
        if (++seqNum > 255)
            seqNum = 1;
        return seqNum;
    };

    this.nextTransId = function () {    // zigbee transection id
        if (++transId > 255)
            transId = 1;
        return transId;
    };

    this.setPermitJoinTime = function (time) {
        permitJoinTime = time;
        return permitJoinTime;
    };
    this.getPermitJoinTime = function () {
        return permitJoinTime;
    };
    this.joinTimeCountdown = function () {
        permitJoinTime = permitJoinTime > 0 ? permitJoinTime - 1 : 0;
        return permitJoinTime;
    };

    /*********************************************************************/
    /***Event Bridges                                                  ***/
    /*********************************************************************/
    this._znp.on('ready', function () {
        self._initCoordinator().then(function () {
            // all ok, check online running
            // if (!appload) => load all apps    [TODO] should load app at shepherd level
        }).fail(function (err) {
            self.emit('ZNP:INIT:FAIL');
        });
    }).done();

    this._znp.on('AREQ', function (msg) {
        bridge._areqEventBridge(self, msg);
    });

    this._attchUpstreamEventEmitters();
}

util.inherits(Controller, EventEmitter);

/*************************************************************************************************/
/*** Public ZigBee Utility APIs                                                                ***/
/*************************************************************************************************/
Controller.prototype.getCoord = function () {
    return this._coord;
};

Controller.prototype.getDelegator = function (profId) {
    return this.getCoord().getDelegator(profId);
};

Controller.prototype.getNwkInfo = function (callback) {
    return _.cloneDeep(this._net);
};
/*************************************************************************************************/
/*** Mandatory Public APIs                                                                     ***/
/*************************************************************************************************/
Controller.prototype.start = function (callback) {
    var self,
        readyLsn;

    readyLsn = function () {
        callback(null);
    };

    this.once('_ready', readyLsn);  // event fired by _initCoordinator();

    this._znp.init(this._cfg, function (err) {
        if (err) {
            self.removeListener('_ready', readyLsn);
            callback(err);
        }
    });

    return this;
};

Controller.prototype.close = function (callback) {
    this._znp.close(callback);
    return this;
};

Controller.prototype.reset = function (mode, callback) {
    var self = this,
        deferred = Q.defer(),
        reqChain,
        steps;

    if (mode === 'soft' || mode === 1) {
        return this.request('SYS', 'resetReq', { type: 0x01 }, function (err) {
            if (err)
                deferred.reject(err);
            else
                deferred.resolve();
        });
    } else if (mode === 'hard' || mode === 0) {
        steps = [
            function () { return self.request('SYS', 'resetReq', { type: 0x00 }).delay(0); },
            function () { return self.request('SAPI', 'writeConfiguration', nvParams.startupOption).delay(4000); },
            function () { return self.request('SYS', 'resetReq', { type: 0x00 }).delay(10); },
            function () { return self.request('SAPI', 'writeConfiguration', nvParams.panId).delay(5000); },
            function () { return self.request('SAPI', 'writeConfiguration', nvParams.extPanId).delay(10); },
            function () { return self.request('SAPI', 'writeConfiguration', nvParams.channelList).delay(10); },
            function () { return self.request('SAPI', 'writeConfiguration', nvParams.logicalType).delay(10); },
            function () { return self.request('SAPI', 'writeConfiguration', nvParams.precfgkey).delay(10); },
            function () { return self.request('SAPI', 'writeConfiguration', nvParams.precfgkeysEnable).delay(10); },
            function () { return self.request('SYS', 'osalNvWrite', nvParams.securityMode).delay(10); },
         // function () { return self.request('AF', 'register', nvParams.afRegister).delay(10); },
            function () { return self.request('SAPI', 'writeConfiguration', nvParams.zdoDirectCb).delay(10); },
         // function () { return self.request('ZDO', 'startupFromApp', { startdelay: 0 }).delay(10); },
            function () { return self.request('SYS', 'osalNvItemInit', nvParams.znpCfgItem).delay(10); },
            function () { return self.request('SYS', 'osalNvWrite', nvParams.znpHasConfigured).delay(10); }
        ];

        reqChain = steps.reduce(function (soFar, fn) {
            return soFar.then(fn);
        }, Q(0));

        reqChain.then(function () {
            deferred.resolve();
        }).fail(function (err) {
            deferred.reject(err);
        }).done();

    } else {
        deferred.reject(new Error('Unknown reset mode.'));
    }

    return deferred.promise.nodeify(callback);
};

Controller.prototype.request = function (subsys, cmdId, valObj, callback) {
    var deferred = Q.defer(),
        rspHdlr;

    rspHdlr = function (err, rsp) {
        if (err)
            deferred.reject(err);
        else if (rsp && rsp.hasOwnProperty('status') && rsp.status !== 0)   // unsuccessful
            deferred.reject(new Error('rsp error: ' + rsp.status));
        else
            deferred.resolve(rsp);
    };

    if (subsys.toUpperCase() === 'ZDO' || subsys === 5)
        this._zdo.request(cmdId, valObj, rspHdlr);          // use wrapped zdo as the exported api
    else
        this._znp.request(subsys, cmdId, valObj, rspHdlr);  // SREQ has timeout inside znp

    return deferred.promise.nodeify(callback);
};

Controller.prototype.permitJoin = function (joinType, joinTime, callback) {
    // ZDO_MGMT_PERMIT_JOIN_REQ
    // joinType: 0 (coord)/ 1 (all)
    // joinTime: seconds, 0 disable, 0xFF always enable
    var self = this,
        deferred = Q.defer(),
        addrmode,
        dstaddr,
        joinTimeDownCounter;

    if (joinType === 0 || 'coord') {
        addrmode = 0x02;
        dstaddr = 0x0000;
    } else if (joinType === 1 || 'all') {
        addrmode = 0xFF;
        dstaddr = 0xFFFC;   // all coord and routers
    } else {
        deferred.reject(new Error('Not a valid joinType.'));
    }

    if (joinTime > 255 || joinTime < 0)
        deferred.reject(new Error('Jointime can only range from  0 to 255.'));

    this.setPermitJoinTime(joinTime);

    // 'addrmode', dstaddr', 'duration', 'tcsignificance'
    this.request('ZDO', 'mgmtPermitJoinReq', {
        addrmode: addrmode,
        dstaddr: dstaddr ,
        duration: joinTime,
        tcsignificance: 0
    }).then(function (result) {
        joinTimeDownCounter = setInterval(function () {
            if (0 === self.joinTimeCountdown())
                clearInterval(joinTimeDownCounter);
        }, 1000);
       deferred.resolve(result);
    }).fail(function (err) {
        deferred.reject(err);
    }).done();

    return deferred.promise.nodeify(callback);
};
/*************************************************************************************************/
/*** Public Apllication Layer APIs                                                             ***/
/*************************************************************************************************/
Controller.prototype.afDataSendByLocalEp = function (localEp, dstEp, cId, rawData, opt, callback) {
    return afSender.afDataSendByLocalEp(this, localEp, dstEp, cId, rawData, opt, callback);
};

Controller.prototype.afDataBroadcastByLocalEp = function (localEp, addrMode, dstAddr, clusterId, rawData, opt, callback) {
    return afSender.afDataBroadcastByLocalEp(this, localEp, addrMode, dstAddr, clusterId, rawData, opt, callback);
};

Controller.prototype.afDataSend = function (dstEp, cId, rawData, opt, callback) {
    return afSender.afDataSend(this, dstEp, cId, rawData, opt, callback);
};

Controller.prototype.afDataGroupcast = function (profId, groupId, clusterId, rawData, opt, callback) {
    return afSender.afDataGroupcast(this, profId, groupId, clusterId, rawData, opt, callback);
};

Controller.prototype.afDataBroadcast = function (profId, clusterId, rawData, opt, callback) {
    return afSender.afDataBroadcast(this, profId, clusterId, rawData, opt, callback);
};

Controller.prototype.zclFoundation = function (dstEp, cId, cmd, zclPayload, callback) {
    // .frame(frameCntl, manufCode, seqNum, cmd, zclPayload[, clusterId])
    var deferred = Q.defer(),
        self = this,
        timeout,
        dev = dstEp.getDev(),
        frameCntl = { frameType: 0, manufSpec: 0, direction: 0, disDefaultRsp: 0 },
        manufId,
        seqNum,
        zclRspEvt,
        zclRspLsn,
        zclPacket;

    if (!dev) {
        deferred.reject(new Error('device not found.'));
        return deferred.promise.nodeify(callback);
    }

    manufId = dev.getManufId();
    seqNum = this.nextSeqNum();

    zclPacket = zcl.frame(frameCntl, manufId, seqNum, cmd, zclPayload);
    //zclRspEvt = 'ZCL:FOUNDATION:read:' + seqNum;
    zclRspEvt = 'ZCL:' + (frameCntl.direction^1) + ':' + cId + ':' + seqNum;

    zclRspLsn = function (zclRspPayload) {
        deferred.resolve(zclRspPayload);
    };

    this.once(zclRspEvt, zclRspLsn);
    
    timeout = setTimeout(function () {
        self.removeListener(zclRspEvt, zclRspLsn);
    }, AREQ_TIMEOUT * 1000);

    this.afDataSend(dstEp, cId, zclPacket, {}).fail(function (err) {
        clearTimeout(timeout);
        deferred.reject(err);
    }).done();

    return deferred.promise.nodeify(callback);
};

Controller.prototype.zclRead = function (dstEp, cId, attrIdArray, callback) {
    // .frame(frameCntl, manufCode, seqNum, cmd, zclPayload[, clusterId])
    var zclPayload;

    zclPayload = attrIdArray.map(function (aId) {
        return { attrId: aId };
    });

    return this.zclFoundation(dstEp, cId, 'read', zclPayload, callback);
};

Controller.prototype.zclWrite = function (dstEp, cId, recArray, callback) {
    // { attrId, dataType, attrData }
    // dataType === array, set or bag, attrData: { elmType, numElms, elmVals }
    // dataType === structure, attrData: { numElms, structElms: [ { elmType, elmVal }, ... ] }
    return this.zclFoundation(dstEp, cId, 'write', recArray, callback);
};

Controller.prototype.zclConfigReport = function (dstEp, cId, recArray, callback) {
    // direction === 0, { direction, attrId, dataType, minRepIntval, maxRepIntval[, repChange] }
    // direction === 1, { direction, attrId, timeout }
    return this.zclFoundation(dstEp, cId, 'configReport', recArray, callback);
};

Controller.prototype.zclReadReportConfig = function (dstEp, cId, recArray, callback) {
    // { direction, attrId }
    return this.zclFoundation(dstEp, cId, 'readReportConfig', recArray, callback);
};

Controller.prototype.zclReadStruct = function (dstEp, cId, recArray, callback) {
    // { attrId, selector: { indicator, indexes: [ ... ] } }
    return this.zclFoundation(dstEp, cId, 'readStruct', recArray, callback);
};

Controller.prototype.zclReport = function (dstEp, cId, recArray, callback) {
    // { attrId, dataType, attrData }
    // dataType === array, set or bag, attrData: { elmType, numElms, elmVals }
    // dataType === structure, attrData: { numElms, structElms: [ { elmType, elmVal }, ... ] }
    return this.zclFoundation(dstEp, cId, 'report', recArray, callback);
};

Controller.prototype.zclWriteStrcut = function (dstEp, cId, recArray, callback) {
    // { attrId, selector: { indicator, indexes: [ ... ] }, dataType, attrData }
    // dataType === array, set or bag, attrData: { elmType, numElms, elmVals }
    // dataType === structure, attrData: { numElms, structElms: [ { elmType, elmVal }, ... ] }
    return this.zclFoundation(dstEp, cId, 'writeStrcut', recArray, callback);
};

Controller.prototype.zclDiscover = function (dstEp, cId, startAttrId, maxAttrIds, callback)  {
    var zclPayload = { startAttrId: startAttrId, maxAttrIds: maxAttrIds };

    return this.zclFoundation(dstEp, cId, 'discover', zclPayload, callback);
    // var deferred = Q.defer(),
    //     apsPayload,
    //     zclCmdRspName = 'DISCOVER_RSP',
    //     zclDefaulRspEventName,
    //     zclEventName;

    // zclHeader.seqNum = epSelf.nextSeqNum();
    // zclHeader.cmdId = ZCLDEFS.FoundationCmdId.get('DISCOVER').value;
    // apsPayload = zclFound.buildFrame(zclHeader, { startAttrId: startAttrId, maxAttrIds: maxAttrIds });

    // //-------
    // zclEventName = 'ZCL_MSG:FOUNDATION:' + zclCmdRspName + ':' + zclHeader.seqNum;
    // zclDefaulRspEventName = 'ZCL_MSG:FOUNDATION:DEFAULT_RSP:' + zclHeader.seqNum;

    // function zclCmdResolver(zclPayload) {
    //     deferred.resolve(zclPayload);
    //     epSelf.removeListener(zclDefaulRspEventName, zclDefaultRspResolver);
    // }

    // function zclDefaultRspResolver(zclPayload) {
    //     deferred.resolve(zclPayload);
    //     epSelf.removeListener(zclEventName, zclCmdResolver);
    // };

    // epSelf.once(zclEventName, zclCmdResolver);
    // epSelf.once(zclDefaulRspEventName, zclDefaultRspResolver);
    // //-------

    // epSelf.send(apsPayload, cId).then(null, function (err) {
    //     deferred.reject(err);   // SRSP fail, or AF:DATA_CONFIRM not ZSuccess, or timeout
    //     epSelf.removeListener(zclDefaulRspEventName, zclDefaultRspResolver);
    //     epSelf.removeListener(zclEventName, zclCmdResolver);
    // });


    // // Controller.prototype.afDataSend = function (dstEp, cId, rawData, opt, callback) {
    // this.afDataSend(dstEp, cId, apsPayload, {}).then(function () {

    // }).fail(function () {

    // }).done();

    // return deferred.promise.nodeify(callback);
};

Controller.prototype.zclCommand = function (dstEp, cId, cmd, valObj, callback)  {
    // [TODO] functional
    // .frame(frameCntl, manufCode, seqNum, cmd, zclPayload[, clusterId])
    var deferred = Q.defer(),
        self = this,
        timeout,
        dev = dstEp.getDev(),
        frameCntl = { frameType: 1, manufSpec: 0, direction: 0, disDefaultRsp: 0 },
        manufId,
        seqNum,
        zclRspEvt,
        zclRspLsn,
        zclPacket;

    if (!dev) {
        deferred.reject(new Error('device not found.'));
        return deferred.promise.nodeify(callback);
    }

    manufId = dev.getManufId();
    seqNum = this.nextSeqNum();

    zclPacket = zcl.frame(frameCntl, manufId, seqNum, cmd, valObj, cId);
    ///zclRspEvt = 'ZCL:FUNCTIONAL:' + cId + ':' +  seqNum;
    zclRspEvt = 'ZCL:' + (frameCntl.direction^1) + ':' + cId + ':' + seqNum;

    zclRspLsn = function (zclRspPayload) {
        deferred.resolve(zclRspPayload);
    };

    this.once(zclRspEvt, zclRspLsn);
    
    timeout = setTimeout(function () {
        self.removeListener(zclRspEvt, zclRspLsn);
    }, AREQ_TIMEOUT * 1000);

    this.afDataSend(dstEp, cId, zclPacket, {}).fail(function (err) {
        clearTimeout(timeout);
        deferred.reject(err);
    }).done();

    return deferred.promise.nodeify(callback);
};

/*************************************************************************************************/
/*** Public Network Layer Querying APIs                                                        ***/
/*************************************************************************************************/
Controller.prototype.queryCoordState = function (callback) {
    return this.querySingleNwkInfo('DEV_STATE');
};

Controller.prototype.querySingleNwkInfo = function (param, callback) {
    var deferred = Q.defer(),
        prop = ZDEF.SAPI.get(param);

    if (!prop) {
        deferred.reject(new Error('Unknown network property.'));
    } else {
        this.request('SAPI', 'getDeviceInfo', { param: prop.value }).then(function (rsp) {
            deferred.resolve(rsp);
        }).fail(function (err) {
            deferred.reject(err);
        }).done();
    }

    return deferred.promise.nodeify(callback);
};
/*************************************************************************************************/
/*** Coordinator and Delegators Initialization [TODO] make private                             ***/
/*************************************************************************************************/
// [TODO] move to ./initializers/init_controller.js after done
Controller.prototype._initCoordinator = function () {
    var self = this;

    return this._initCoordAtConnected().then(function (nwkInfo) {
        return self._initCoordAfterConnected(nwkInfo);
    }).then(function () {
        return self._recoverFromDataBase(); // [TODO]
    }).then(function () {
        return self._checkOnlineOfAll();
    });

};

// [TODO] move to ./initializers/init_controller.js after done
Controller.prototype._initCoordAtConnected = function () {
    var self = this;
    // check if znp coord has booted up
    return this.queryCoordState().then(function (state) {
        if (state === 'ZB_COORD' || state === 0x09)
            return self.queryNwkInfo(); // coord has started
        else
            return self._initBootCoordFromApp();
    }).then(function (nwkInfo) {
        self.setNetInfo(nwkInfo);
        return nwkInfo;
    });
};  // return nwkInfo: { state, channel, panId, extPanId, ieeeAddr, nwkAddr }

// [TODO] move to ./initializers/init_controller.js after done
Controller.prototype._initBootCoordFromApp = function () {
    var self = this,
        waitBootTime = 3000;

    return this.request('ZDO', 'startupFromApp', { startdelay: 100 }).then(function (rsp) {
        return Q.delay(rsp, waitBootTime);
    }).then(function () {
        // all registered endpoints on coord are cleared when coord boots/reboots
        return self.queryNwkInfo();
    });
};  // return nwkInfo

// [TODO] move to ./initializers/init_controller.js after done
Controller.prototype._initCoordAfterConnected = function (nwkInfo) {
    var self = this,
        isCoordRunning = !!this.getCoord();

    this.queryCoordInfo().then(function (coordInfo) {   // coordInfo = { type, ieeeAddr, nwkAddr, manufId, epList }
        if (!isCoordRunning) {
            self._coord = new Coordinator(coordInfo);   // create a new coord
            self.delegators = null;                     // clear all delegators

            var dlgIPM = new Coordpoint(self._coord, { profId: 0x0101, epId: 1, devId: 0x0005, inCList: [], outCList: [] }, true),  // 'IPM': 0x0101, Industrial Plant Monitoring
                dlgHA = new Coordpoint(self._coord, { profId: 0x0104, epId: 2, devId: 0x0005, inCList: [], outCList: [] }, true),   // 'HA': 0x0104, Home Automation
                dlgCBA = new Coordpoint(self._coord, { profId: 0x0105, epId: 3, devId: 0x0005, inCList: [], outCList: [] }, true),  // 'CBA': 0x0105, Commercial Building Automation
                dlgTA = new Coordpoint(self._coord, { profId: 0x0107, epId: 4, devId: 0x0005, inCList: [], outCList: [] }, true),   // 'TA': 0x0107, Telecom Applications
                dlgPHHC = new Coordpoint(self._coord, { profId: 0x0108, epId: 5, devId: 0x0005, inCList: [], outCList: [] }, true), // 'PHHC': 0x0108, Personal Home & Hospital Care
                dlgSE = new Coordpoint(self._coord, { profId: 0x0109, epId: 6, devId: 0x0005, inCList: [], outCList: [] }, true);   // 'SE': 0x0109, Smart Energy 'AMI': 0x0109, Advanced Metering Initiative, Smart Energy

            self.delegators = [ dlgIPM, dlgHA, dlgCBA, dlgTA, dlgPHHC, dlgSE ];
        }

        return self._delegators;
    }).then(function (dlgs) {
        var registerResults = [];

        dlgs.forEach(function (dlgEp) {
            registerResults.push(self._coord.reRegisterEndpoint(dlgEp));
        });

        return Q.all(registerResults);
    }).fail(function () {
        self.emit('ZNP:INIT:FAIL');
    }).then(function () {
        self.emit('ZNP:INIT');
    });
};

module.exports = Controller;


function zclFoundationCmdPayload(cmd, args) {
    switch (cmd) {
        case 'read':
            // [ { attrId }, ... ]
            break;
        case 'write':
        case 'writeUndiv':
        case 'writeNoRsp':
            // [ { attrId, dataType, attrData }, ... ], check data type and throw
            break;
        case 'configReport':
            // [ { direction, attrId }, ... ]
            break;
        case 'readReportConfig':
            // [ { direction, attrId }, ... ]
            break;
        // case 'report':  // this is response
        //     // [ { attrID, dataType, attrData }, ... ], check data type and throw
        //     break;
        case 'discover':
            // { startAttrId, maxAttrIds }
            break;
        case 'readStruct':      // readStruct not supported by TI
            // [ { attrId, selector }, ... ]
            break;
        case 'writeStrcut':     // writeStrcut not supported by TI
            // [ { attrId, selector, dataType, attrData }, ... ]
            break;
    }

}