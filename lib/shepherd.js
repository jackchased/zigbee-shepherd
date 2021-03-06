/* jshint node: true */
'use strict';

var util = require('util'),
    EventEmitter = require('events').EventEmitter;

var ObjectBox = require('Objectbox'),
    Coordinator = require('coordinator'),
    Controller = require('controller');

function ZShepherd(cfg) {
    EventEmitter.call(this);

    var self = this;

    this._devbox = new ObjectBox();         // db integration
    this._epbox = new ObjectBox();          // db integration
    this.coord = new Coordinator();         // coord is just a device, but with local endpoint and applications
    this.controller = new Controller(cfg);  // controller is the main actor

    this.request = this.controller.request; // the request method is exported by controller

    // many basic events
    this.on('ZNP:devIncoming');
    this.on('ZNP:devLeaving');
    this.on('ZNP:epIncoming');
    this.on('ZNP:epLeaving');
    this.on('ZNP:devChanged');
    this.on('ZNP:epChanged');


    this.controller.on('ZDO:serverDiscRsp', function (rspMsg) {     // rspMsg: { srcaddr, status, servermask }
    });

    this.controller.on('ZDO:stateChangeInd', function (msg) {       // { state[, nwkaddr] }
    });

    this.controller.on('ZDO:endDeviceAnnceInd', function (msg) {    // { srcaddr, nwkaddr, ieeeaddr, capabilities }
    });

    this.controller.on('ZDO:matchDescRspSent', function (msg) {     // { nwkaddr, numinclusters, inclusterlist, numoutclusters, outclusterlist }
    });

    this.controller.on('ZDO:statusErrorRsp', function (msg) {       // { srcaddr, status }
    });

    this.controller.on('ZDO:srcRtgInd', function (msg) {            // { dstaddr, relaycount, relaylist }
    });

    this.controller.on('ZDO:beacon_notify_ind', function (msg) {    // { beaconcount, beaconlist }
    });

    this.controller.on('ZDO:leaveInd', function (msg) {             // { srcaddr, extaddr, request, removechildren, rejoin }
    });

    this.controller.on('ZDO:msgCbIncoming', function (msg) {        // { srcaddr, wasbroadcast, clusterid, securityuse, seqnum, macdstaddr, msgdata }
    });

    this.controller.on('ZDO:tcDeviceInd', function (msg) {          // { nwkaddr, extaddr, parentaddr }
    });

    this.controller.on('ZDO:permitJoinInd', function (msg) {        // { duration }
    });
}

util.inherits(Controller, EventEmitter);
ZShepherd.prototype.newZigbeeApp = function () {

};


ZShepherd.prototype._devLeavingHandler = function (msg) {};
ZShepherd.prototype._epIncomingHandler = function (msg) {};
ZShepherd.prototype._epLeavingHandler = function (msg) {};
ZShepherd.prototype._devChangedHandler = function (msg) {};
ZShepherd.prototype._epChangedHandler = function (msg) {};


ZShepherd.prototype._devIncomingHandler = function (msg) {
    // msg: { srcaddr, nwkaddr, ieeeaddr, capabilities }
    var self = this,
        oldDev = this.findDev({ ieeeAddr: msg.ieeeaddr });

    this.controller.queryDevFullInfo(msg.ieeeaddr, msg.nwkaddr).then(function (devInfo) {
        // devInfo: { type, ieeeAddr, nwkAddr, manufId, epList, endpoints: epInfos }
        var epInfos = devInfo.endpoints,
            dev;

        if (oldDev) {
            dev = oldDev;
            dev.updateDevInfo(devInfo);
        } else {
            dev = new Device(devInfo);
        }

        epInfos.forEach(function (epInfo) {
            var oldEp = self.findEp(msg.ieeeaddr, epInfo.epId),
                ep;

            if (oldEp) {
                ep = oldEp;
                ep.updateEpInfo(epInfo);
            } else {
                ep = new Endpoint(dev, epInfo);
                ep.syncClusters();
            }
        });
    });
};


/*************************************************************************************************/
/*** Local Endpoint                                                                            ***/
/*************************************************************************************************/
ZShepherd.prototype.zApp = function () {

};

/*************************************************************************************************/


// shepherd._checkZclSupport(this.profId, this.getDevice().getManufId(), this.devId);
/*************************************************************************************************/
/*** Public APIs                                                                               ***/
/*************************************************************************************************/
ZShepherd.prototype.start = function () {

};

ZShepherd.prototype.getController = function () {
    return this._controller;
};

ZShepherd.prototype.createLocalApp = function () {

};

module.exports = ZShepherd;


// listen: controller init done 
    // show network info, getCoordInfo, newZbDevice, newZbEndpoint, .zbSysMgrEp = zbEp, zbCoord.registerEndpoint(zbEp)
    // loadDevicesFromDb(), zbDev.loadEndpointsFromDb(), zbDev.checkOnline(), 
// listen: connect
    // retrieveSingleNwkInfo(devStateNvCode) -> readDevState.key === 'ZB_COORD' -> retrieveNwkInfo() -> .emit('COORD_INIT_DONE')
    //                                          (x) -> zdo.startupFromApp -> retrieveNwkInfo() -> zdb.getInfo('endpoint', nwkInfo.ieeeAddr, sysMgrEpId)
    //                                              -> resetSysEpRegistered() -> .emit('COORD_INIT_DONE')
// listen: endpoint register indication
// listen: epMgrDeviceAnnceListener
// listen: devMgrDeviceAnnceListener
// listen: zdoLeaveIndListener
// listen: zdoEdAnnceIndListener


/* jshint node: true */
'use strict';

var util = require('util'),
    EventEmitter = require('events').EventEmitter;

var Q = require('q'),
    _ = require('lodash'),
    ccznp = require('cc-znp');

var Device = require('./devClass'),
    Endpoint = require('./epClass');

function ZShepherd() {
    EventEmitter.call(this);

    var self = this;

    // info from coord instance
    // this.panId = undefined;
    // this.extPanId = undefined;
    // this.ieeeAddr = undefined;
    // this.nwkAddr = 0x0000;
    // this.numEp = undefined;
    // this.epList = undefined; // [a, b, ...]
    // this.endPoints = [];
    // this._channel = null;

    this.zbDevices = [];

    this._innerListeners = {
        ccznpReady: function () {
            self._initCoord();
            self.on('endDeviceAnnceInd', endDeviceAnnceIndLsn);
        },
        ccznpAreq: function (areqMsg) {
            self.emit(areqMsg.cmd, areqMsg.payload);
        },
        ccznpClose: function () {
            console.log('cc-znp is closed');
        }
    };
}



util.inherits(ZShepherd, EventEmitter);

var zshepherd = new ZShepherd();

/*************************************************************************************************/
/*** Public APIs                                                                               ***/
/*************************************************************************************************/
ZShepherd.prototype.init = function (spCfg, channel, panId) {
    this._channel = channel || 11;
    this._panId = panId || 0xFFFF;

    // Listeners for inner use
    var ccznpReadyLsn = this._innerListeners.ccznpReady,
        ccznpAreqLsn = this._innerListeners.ccznpAreq,
        ccznpCloseLsn = this._innerListeners.ccznpClose;

    // remove all inner listeners were attached on last init
    ccznp.removeListener('ready', ccznpReadyLsn);
    ccznp.removeListener('AREQ', ccznpAreqLsn);
    ccznp.removeListener('close', ccznpCloseLsn);

    // re-attach inner listeners
    ccznp.once('ready', ccznpReadyLsn);
    ccznp.on('AREQ', ccznpAreqLsn);
    ccznp.on('close', ccznpCloseLsn);

    ccznp.init(spCfg, function (err) {
        console.log(err);
    });
};

ZShepherd.prototype.findDev = function (ieeeAddr) {
    return _.find(this.zbDevices, { ieeeAddr: ieeeAddr });
};

ZShepherd.prototype.findEp = function (ieeeAddr, epId) {
};

ZShepherd.prototype.bind = function (srcEp, cId, dstEp, callback) {
    var self = this;

    var bindReqParm = {
            dstaddr: srcEp.ownerDevice.nwkAddr,
            srcaddr: srcEp.ownerDevice.ieeeAddr,
            srcendpoint: srcEp.ep,
            clusterid: cId,
            dstaddrmode: 0x03,
            addr_short_long: dstEp.ownerDevice.ieeeAddr,
            dstendpoint: dstEp.ep
        };

    this.ccznpRequest('ZDO', 'bindReq', bindReqParm).then(function () {
        self.once('bindRsp',function (payload) {
            if (payload.status === 0) // SUCCESS
                callback(true);
            else
                callback(false);
        });
    }).fail(function (err) {
        console.log(err);
    }).done();

};

ZShepherd.prototype.unbind = function (srcEp, cId, dstEp, callback) {

};

ZShepherd.prototype.sendGroupcastMsg = function (groupId, clusterId, cmdId, valObj, callback) {

};

ZShepherd.prototype.sendBroadcastMsg = function (clusterId, cmdId, argInst, callback) {

};

ZShepherd.prototype.permitJoin = function (time) {

};

ZShepherd.prototype.registerEndpoint = function (epInfo, callback) {

};

ZShepherd.prototype.ccznpRequest = function (subsys, cmdId, valObj, callback) {
    var deferred = Q.defer();

    ccznp.request(subsys, cmdId, valObj, function (err, result) {
        if (err)
            deferred.reject(err);
        else
            deferred.resolve(result);
    });

    return deferred.promise.nodeify(callback);
};

/*************************************************************************************************/
/*** Protected Methods                                                                         ***/
/*************************************************************************************************/
ZShepherd.prototype._registerZcl = function (zclModule) {
    this._zcl = zclModule;
};

ZShepherd.prototype._initCoord = function () {
    var self = this;

    var nvStartupOptionParm = {configid: 0x03, len: 0x01, value: [0x02]},
        nvPanIdParm = {configid: 0x83, len: 0x02, value: [0xFF, 0xFF]},
        nvExtPanIdParm = {configid: 0x2D, len: 0x08, value: [0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD]},
        nvChanlistParm = {configid: 0x84, len: 0x04, value: [0x00, 0x08, 0x00, 0x00]}, // Little endian. Ex: value: [0x00, 0x08, 0x00, 0x00] for CH11
        nvLogicalTypeParm = {configid: 0x87, len: 0x01, value: [0x00]},
        nvPrecfgkeyParm = {configid: 0x62, len: 0x10, value: [0x01, 0x03, 0x05, 0x07, 0x09, 0x0B, 0x0D, 0x0F, 0x00, 0x02, 0x04, 0x06, 0x08, 0x0A, 0x0C, 0x0D]},
        nvPrecfgkeysEnableParm = {configid: 0x63, len: 0x01, value: [0x00]},
            // value: 0 (FALSE) only coord defualtKey need to be set, and OTA to set other devices in the network.
            // value: 1 (TRUE) Not only coord, but also all devices need to set their defualtKey (the same key). Or they can't not join the network.
        nvTcLinkKeyParm = {id: 0x0101, offset: 0x00, len: 0x20, value: [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x5a, 0x69, 0x67, 0x42, 0x65, 0x65, 0x41, 0x6c, 0x6c, 0x69, 0x61, 0x6e, 0x63, 0x65, 0x30, 0x39, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]},
            // ZigBee Alliance Pre-configured TC Link Key - 'ZigBeeAlliance09'
        afRegisterParm = {endpoint: 0x01, appprofid: 0x0104, appdeviceid: 0x0005, appdevver: 0x00, latencyreq: 0x00, appnuminclusters: 0x00, appinclusterlist: [], appnumoutclusters: 0x00, appoutclusterlist: []};

    this.ccznpRequest('SYS', 'resetReq', {type: 0}).then(function () {
        return self.ccznpRequest('SAPI', 'writeConfiguration', nvStartupOptionParm);
    }).then(function () {
        return self.ccznpRequest('SYS', 'resetReq', {type: 0});
    }).then(function () {
        return self.ccznpRequest('SAPI', 'writeConfiguration', nvPanIdParm);
    }).then(function () {
        return self.ccznpRequest('SAPI', 'writeConfiguration', nvExtPanIdParm);
    }).then(function () {
        return self.ccznpRequest('SAPI', 'writeConfiguration', nvChanlistParm);
    }).then(function () {
        return self.ccznpRequest('SAPI', 'writeConfiguration', nvLogicalTypeParm);
    }).then(function () {
        return self.ccznpRequest('SAPI', 'writeConfiguration', nvPrecfgkeyParm);
    }).then(function () {
        return self.ccznpRequest('SAPI', 'writeConfiguration', nvPrecfgkeysEnableParm);
    }).then(function () {
        return self.ccznpRequest('SYS', 'osalNvWrite', nvTcLinkKeyParm);
    }).then(function () {
        return self.ccznpRequest('AF', 'register', afRegisterParm);
    }).then(function () {
        return self.ccznpRequest('ZDO', 'startupFromApp', {startdelay: 0});
    }).fail(function (err) {
        console.log(err);
    }).done();
};

ZShepherd.prototype._getDevInfo = function (nwkAddr, ieeeAddr, callback) {
    var self = this,
        deferred = Q.defer(),
        devInfo = {};

    devInfo.nwkAddr = nwkAddr;
    devInfo.ieeeAddr = ieeeAddr;

    this.ccznpRequest('ZDO', 'nodeDescReq', {dstaddr: nwkAddr, nwkaddrofinterest: nwkAddr}).then(function () {
        self.once('nodeDescRsp',function (payload) {
            devInfo.devtype = payload.logicaltype_cmplxdescavai_userdescavai & 0x03;
        });

        return self.ccznpRequest('ZDO', 'activeEpReq', {dstaddr: nwkAddr, nwkaddrofinterest: nwkAddr});
    }).then(function () {
        self.once('activeEpRsp',function (payload) {
            devInfo.numEp = payload.activeepcount;
            devInfo.epList = payload.activeeplist;
            deferred.resolve(devInfo);
        });
    }).fail(function (err) {
        console.log(err);
    }).done();

    return deferred.promise.nodeify(callback);
};

ZShepherd.prototype._getEpInfo = function (nwkAddr, epId, callback) {
    var self = this,
        deferred = Q.defer(),
        epInfo = {};

    epInfo.ep = epId;

    this.ccznpRequest('ZDO', 'simpleDescReq', {dstaddr: nwkAddr, nwkaddrofinterest: nwkAddr, endpoint: epId}).then(function () {
        self.once('simpleDescRsp',function (payload) {
            epInfo.profileId = payload.profileid;
            epInfo.deviceId = payload.deviceid;
            epInfo.numInClusters = payload.numinclusters;
            epInfo.inClusterList = payload.inclusterlist;
            epInfo.numOutClusters = payload.numoutclusters;
            epInfo.outClusterList = payload.outclusterlist;
            deferred.resolve(epInfo);
        });
    },function (err) {
        console.log(err);
    }).done();

    return deferred.promise.nodeify(callback);
};

/*************************************************************************************************/
/*** Listeners                                                                                 ***/
/*************************************************************************************************/
function endDeviceAnnceIndLsn(devIndMsg) {
    var dev,
        ep;

    zshepherd._getDevInfo(devIndMsg.nwkaddr, devIndMsg.ieeeaddr).then(function (devInfo) {
        dev = new Device(devInfo);
        zshepherd.zbDevices.push(dev);
        // console.log(dev);

        if (dev.numEp !== 0) {
            var idx;

            for (idx = 0; idx < dev.numEp; idx += 1) {
                zshepherd._getEpInfo(dev.nwkAddr, dev.epList[idx], function (err, epInfo) {
                    if (err) {
                        console.log(err);
                        return;
                    }

                    epInfo.ownerDevice = dev;
                    ep = new Endpoint(epInfo);
                    dev.zbEndPoints.push(ep);
                    // console.log(ep);

                    if (idx === dev.numEp)
                        zshepherd.emit('IND', {type: 'DEV_INCOMING', data: dev.ieeeAddr});
                });
            }
        }
    },function (err) {
        console.log(err);
    }).done();
}


// [TODO] find from database
querie.deviceList = function (addrObj, callback) {
    var deferred = Q.defer(),
        deviceList = [];

    // [TODO] not remote, not query =? getDevList

    // var deferred = Q.defer(),
    //     nwkSelf = this,
    //     devList = [],
    //     i;
    // if (addrObj.hasOwnProperty('ieeeAddr') || addrObj.hasOwnProperty('nwkAddr')) {
    //     getSingleDev(addrObj).then(function (devInfo) {
    //         deferred.resolve(devInfo);
    //     }, function (err) {
    //         deferred.reject(err);
    //     });
    // } else {
    //     zdb.getInfo('device').then(function (devs) {
    //         if (devs) {
    //             for (i = 0; i < devs.length; i++) {
    //                 getSingleDev({ ieeeAddr: devs[i].ieeeAddr }).then(function (dev) {
    //                     devList.push(dev);
    //                     if (devList.length === devs.length) {
    //                         deferred.resolve(devList);
    //                     }
    //                 }, function (err) {
    //                     deferred.reject(err);
    //                 });
    //             }
    //         }
    //     }, function (err) {
    //         deferred.reject(err);
    //     }); 
    // }
    // return deferred.promise.nodeify(callback);
};
/*************************************************************************************************/
/*** Export as a singleton                                                                     ***/
/*************************************************************************************************/
module.exports = zshepherd;
