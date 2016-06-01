/* jshint node: true */
'use strict';

var zcl = require('zcl-packet');
var zdoHelper = require('./zdo_helper.js');
var bridge = {};

bridge._areqEventBridge = function (controller, msg) {
    // msg: { subsys: 'ZDO', ind: 'endDeviceAnnceInd', data: { srcaddr: 63536, nwkaddr: 63536, ieeeaddr: '0x00124b0001ce3631', ... }
    var mandatoryEvent1 = 'ind',
        mandatoryEvent2 = msg.subsys + ':' + msg.ind;       // 'SYS:resetInd', 'SYS:osalTimerExpired'

    controller.emit(mandatoryEvent1, msg);                  // bridge 'AREQ' to 'ind' event
    controller.emit(mandatoryEvent2, msg.data);             // bridge to subsystem events, like 'SYS:resetInd', 'SYS:osalTimerExpired'

    // dispatch to specific event bridge
    if (msg.subsys === 'AF')
        bridge._afIndicationEventBridge(controller, msg);   // AF_INCOMING_MSG and AF_INCOMING_MSG_EXT require special handling that bridge cannot simply handle with
    else if (msg.subsys === 'ZDO')
        bridge._zdoIndicationEventBridge(controller, msg);
    else if (msg.subsys === 'SAPI')
        bridge._sapiIndicationEventBridge(controller, msg);
    // else: Do nothing. No need to bridge: SYS, MAC, NWK, UTIL, DBG, APP
};

bridge._afIndicationEventBridge = function (controller, msg) {
// 4 types of ind:
//  - dataConfirm,    { status, endpoint, transid }
//  - reflectError,   { status, endpoint, transid, dstaddrmode, dstaddr }
//  - incomingMsg,    { groupid, clusterid, srcaddr, srcendpoint, dstendpoint, wasbroadcast, 
//                      linkquality, securityuse, timestamp, transseqnumber, len, data }
//  - incomingMsgExt, { groupid, clusterid, srcaddrmode, srcaddr, srcendpoint, srcpanid, dstendpoint, 
//                      wasbroadcast, linkquality, securityuse, timestamp, transseqnumber, len, data }

    var shepherd = controller._shepherd,
        coord = controller.getCoord(),
        payload = msg.data,
        afEventHead = 'AF:' + msg.ind;

    switch (msg.ind) {
        case 'dataConfirm':
            var afEventCnf = afEventHead + ':' + payload.endpoint + ':' + payload.transid;  // For afDataSend() confirmation
            controller.emit(afEventCnf, payload);
            break;
        case 'reflectError':
            // [TODO]
            // reflectError: [ 'endpoint', 'transid' ]
            // remoteEp.onAfReflectError = function (msg) {};
            break;
        case 'incomingMsg':
            var srcDev = shepherd.findDev({ nwAddr: payload.srcaddr }), // src maybe remote, maybe local
                srcEpId = payload.srcendpoint,
                localEpId = payload.dstendpoint,                        // local ep maybe delegator, maybe zapp
                afEventGeneric = afEventHead + ':' + payload.srcaddr + ':' + payload.clusterid + ':' + localEpId,               // [TODO] who is listeneing
                afEventToRemoteEp,  // afEventToRemoteEp = afEventHead + ':' + srcDev.getIeeeAddr() + ':' + srcEpId;            // [TODO] who is listeneing
                afEventTLocalEp,    // afEventTLocalEp = afEventHead + ':' + coord.getIeeeAddr() + ':' + localEpId;             // [TODO] who is listeneing
                srcEp,
                localEp;

            if (!srcDev)
                return;     // ignore message from unknown device

            srcEp = srcDev.findEndpoint(srcEpId);       // src maybe remote, maybe local
            localEp = coord.findEpdpoint(localEpId);    // local ep maybe delegator, maybe zapp

            controller.emit(afEventGeneric, payload);

            if (srcEp)
                srcEp._receiveAfIncominfMsg(payload);

            if (localEp && localEp !== srcEp)           // found srcEp could be a local one, don't receive twice
                localEp._receiveAfIncominfMsg(payload);

            // zcl parsing
            bridge._zclIndicationEventBridge(controller, srcEp, localEp, payload);
            break;
        case 'incomingMsgExt':
            // remoteEp.onAfIncomingMsgExt = function (msg) {};

            break;
        default:
            break;
    }
};

bridge._zdoIndicationEventBridge = function (controller, msg) {
    // msg: { subsys: 'ZDO', ind: 'endDeviceAnnceInd', data: { srcaddr: 63536, nwkaddr: 63536, ieeeaddr: '0x00124b0001ce3631', ... }
    var payload = msg.data,
        zdoEventHead = 'ZDO:' + msg.ind,
        zdoBridgedEvent;

    if (msg.ind === 'stateChangeInd') {     // this is a special event

        if (!payload.hasOwnProperty('nwkaddr')) // Coord itself
            zdoBridgedEvent = 'coordStateInd';  // console.log('Coord is now in state: ' + payload.state);
        else if (payload.state === 0x83 || payload.state === 'NOT_ACTIVE')
            zdoBridgedEvent = zdoEventHead + ':' + payload.nwkaddr + ':NOT_ACTIVE';
        else if (payload.state === 0x82 || payload.state === 'INVALID_EP')
            zdoBridgedEvent = zdoEventHead + ':' + payload.nwkaddr + ':INVALID_EP';

    } else {
        zdoBridgedEvent = zdoHelper.generateEventOfIndication(msg.ind, payload);
    }

    if (zdoBridgedEvent)
        controller.emit(zdoBridgedEvent, payload);
};

bridge._sapiIndicationEventBridge = function (controller, msg) {
    var payload = msg.data,
        afEventHead = 'SAPI:' + msg.ind,
        afBridgedEvent;

    switch (msg.ind) {
        case 'bindConfirm':
            afBridgedEvent = afEventHead + ':' + payload.commandid;
            break;
        case 'sendDataConfirm':
            afBridgedEvent = afEventHead + ':' + payload.handle;
            break;
        case 'receiveDataIndication':
            afBridgedEvent = afEventHead + ':' + payload.source + ':' + payload.command;
            break;
        case 'findDeviceConfirm':
            if (payload.hasOwnProperty('result'))
                afBridgedEvent = afEventHead + ':' + payload.result; // [TODO] payload.result is IEEE ADDR check if should transform
            break;
        default:    // startConfirm and allowBindConfirm need no bridging
            break;
    }

    if (afBridgedEvent)
        controller.emit(afBridgedEvent, payload);
};

// [TODO]
bridge._zclIndicationEventBridge = function (controller, srcEp, localEp, payload) {
    // srcEp maybe remote, maybe local
    // local ep maybe delegator, maybe zapp

    var isRemoteEp = false,
        isDstEpDelegator = false,
        clusterId = payload.clusterid,
        zclPacket = payload.data,
        zclHeader,
        zclDirection,
        zclPayload,
        seqNum,
        zclBridgedEvent;

    if (srcEp && srcEp.isZclSupported()) {

    } else if (localEp && (localEp !== srcEp) && localEp.isZclSupported()) {

    }


    isRemoteEp = !!srcEp.isLocal();
    isDstEpDelegator = srcEp.isDelegator();

    if (isRemoteEp && !isDstEpDelegator)
        return; // msg is from a remote ep, but this msg is to a local ep, just return and do nothing.
                // Local ep will handle this message, since the same message is also going to local ep.

    if (!srcEp.isZclSupported())
        return; // unsupport zcl, no further parsing required

    /* Start ZCL parsing */
    zclHeader = zcl.header(zclPacket);  // [TODO] need check if header cannot be parse in zcl-packet

    if (!zclHeader)
        return;

    zclDirection = zclHeader.frameCntl.direction;
    
    if (0 === zclHeader.frameCntl.frameType) {          // 0: foundation
        zcl.parse(zclPacket, function (err, zclData) {
            seqNum = zclData.seqNum;
            zclPayload = zclData.payload;
            zclBridgedEvent = 'ZCL:' + zclDirection + ':' + clusterId + ':' + seqNum;
            // zclData.payload
            // 'ZCL:FOUNDATION:cmd'             direction === 0, zcl msg received from client side of node clusters
            // 'ZCL:FOUNDATION:cmd:seqNum'      direction === 1, zcl msg received from server side of node clusters
        });
    } else if (1 === zclHeader.frameCntl.frameType) {   // 1: functional
        zcl.parse(zclPacket, clusterId, function (err, zclData) {
            seqNum = zclData.seqNum;
            zclPayload = zclData.payload;
            zclBridgedEvent = 'ZCL:' + zclDirection + ':' + clusterId + ':' + seqNum;
            // zclData.payload
        });
    }

    if (zclBridgedEvent)
        controller.emit(zclBridgedEvent, zclPayload);

    // here, deal with public profile or private profile that supports zcl style
    // zcl.parse(zclPacket, clusterId, function (err, zclMsg) {
    //     if (err)
    //         return;

    //     var frameType = zclMsg.frameCntl.frameType,
    //         direction = zclMsg.frameCntl.direction;

    //     if (frameType === 0) {          // FOUNDATION, across entire profile
    //         if (!isRemoteEp) {
    //             controller.emit('ZCL:FOUNDATION', zclMsg);    // [TODO] zclMsg need new format?
    //         } else {
    //             if (direction === 0)                                    // zcl msg received from client side of node clusters
    //                 controller.emit('ZCL:FOUNDATION:' + zclMsg.cmd, zclMsg);
    //             else if (direction === 1)                               // zcl msg received from server side of node clusters
    //                 controller.emit('ZCL:FOUNDATION:' + zclMsg.cmd + ':' + zclMsg.seqNum, zclMsg);
    //         }
    //     } else if (frameType === 1) {   // FUNCTIONAL, cluster-specific
    //         if (!isRemoteEp) {
    //             controller.emit('ZCL:FUNCTIONAL', zclMsg);    // [TODO] zclMsg need new format?
    //         } else {
    //             if (direction === 0)                                    // zcl msg received from server side of node clusters
    //                 console.log(zclMsg.cmd + ':TODO: Server side of Coord clusters has not been implemented yet!');     
    //             else if (direction === 1)                               // zcl msg received from client side of node clusters
    //                 controller.emit('ZCL:FUNCTIONAL:' + zclMsg.cmd + ':' + zclMsg.seqNum, zclMsg);
    //         }
    //     } else {
    //         console.log('Unrecognized zcl frame type.');
    //     }
    // });
};

module.exports = bridge;
