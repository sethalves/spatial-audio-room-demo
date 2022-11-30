//
//  Created by Ken Cooke on 3/11/22.
//  Copyright 2022 High Fidelity, Inc.
//
//  The contents of this file are PROPRIETARY AND CONFIDENTIAL, and may not be
//  used, disclosed to third parties, copied or duplicated in any form, in whole
//  or in part, without the prior written consent of High Fidelity, Inc.
//

'use strict';


// create Agora client
let client = AgoraRTC.createClient({
    mode: "rtc",
    codec: "vp8"
});

let localTracks = {
    //videoTrack: null,
    audioTrack: null
};

let remoteUsers = {};

// Agora client options
let options = {
    appid: null,
    channel: null,
    uid: null,
    token: null,
    username: null
};

function decrypt_appid(data, key) {
    let k = BigInt(key.split('').reduce((a, b) => a = Math.imul(a, 33) + b.charCodeAt(0) | 0, 0));
    let t = BigInt('0x' + data) ^ (k * 38038099725390353860267635547n);
    return t.toString(16);
}

// the demo can auto join channel with params in url
$(()=>{
    let urlParams = new URL(location.href).searchParams;
    options.channel = urlParams.get("channel");
    options.password = urlParams.get("password");
    options.username = urlParams.get("username");
    if (options.channel && options.password) {
        $("#channel").val(options.channel);
        $("#password").val(options.password);
        $("#username").val(options.username);
        //$("#join-form").submit();
    }
}
)

$("#username").change(function (e) {
    options.username = $("#username").val();

    // if already connected, update my name
    if (localTracks.audioTrack) {
        usernames[options.uid] = options.username;
        client.sendStreamMessage((new TextEncoder).encode(usernames[options.uid]));
        console.log('%cusername changed, sent stream-message of:', 'color:cyan', usernames[options.uid]);
    }
})

$("#join-form").submit(async function(e) {
    e.preventDefault();
    $("#join").attr("disabled", true);
    try {
        options.appid = decrypt_appid($("#appid").val(), $("#password").val());
        options.token = $("#token").val();
        options.channel = $("#channel").val();
        options.username = $("#username").val();
        await join();
        $("#success-alert").css("display", "block");
    } catch (error) {
        console.error(error);
    } finally {
        $("#leave").attr("disabled", false);
    }
})

$("#leave").click(function(e) {
    leave();
    $("#success-alert").css("display", "none");
})

let isAecEnabled = false; // !window.chrome;
$("#aec").css("background-color", isAecEnabled ? "purple" : "");
$("#aec").click(async function(e) {
    // toggle the state
    isAecEnabled = !isAecEnabled;
    $("#aec").css("background-color", isAecEnabled ? "purple" : "");

    // if already connected, leave and rejoin
    if (localTracks.audioTrack) {
        await leave();
        $("#join").attr("disabled", true);
        await join();
        $("#leave").attr("disabled", false);
    }
})

let isMuteEnabled = false;
$("#mute").click(function(e) {
    // toggle the state
    isMuteEnabled = !isMuteEnabled;
    $("#mute").css("background-color", isMuteEnabled ? "purple" : "");

    // if muted, set gate threshold to 0dB, else follow slider
    setThreshold(isMuteEnabled ? 0.0 : threshold.value);
})

$("#sound").click(function(e) {
    $("#sound").attr("hidden", true);   // only start once

    startLocalSound(-1, "sounds/campfire.wav", -3.2, -3, 0);
    startLocalSound(-2, "sounds/owl.wav", -3, 3.5, 0);
    startLocalSound(-3, "sounds/waterfall.wav", 2.5, 3.2, 0);
    startLocalSound(-4, "sounds/thunder.wav", 3, -2.5, 0);
})

// threshold slider
threshold.oninput = () => {
    if (!isMuteEnabled) {
        setThreshold(threshold.value);
    }
    document.getElementById("threshold-value").value = threshold.value;
}

let canvasControl;
const canvasDimensions = { width: 8, height: 8 };   // in meters
let elements = [];
let usernames = {};

let audioElement = undefined;
let audioContext = undefined;

let hifiSources = {};
let hifiAudioLevels = {};
let hifiAudioLevelsTimer = undefined;
let hifiNoiseGate = undefined;  // mic stream connects here
let hifiPosition = {
    x: 2.0 * Math.random() - 1.0,
    y: 2.0 * Math.random() - 1.0,
    o: 0.0
};

function sourceMetadata(buffer, uid) {
    let data = new DataView(buffer);

    let x = data.getInt16(0) * (1/256.0);
    let y = data.getInt16(2) * (1/256.0);
    let o = data.getInt8(4) * (Math.PI / 128.0);

    // update hifiSource position
    let hifiSource = hifiSources[uid];
    if (hifiSource !== undefined) {
        hifiSource._x = x;
        hifiSource._y = y;
        hifiSource._o = o;
        setPosition(hifiSource);
    }

    // update canvas position
    let e = elements.find(e => e.uid === uid);
    if (e !== undefined) {
        e.x = 0.5 + (x / canvasDimensions.width);
        e.y = 0.5 - (y / canvasDimensions.height);
        e.o = o;
    }
}

function setThreshold(value) {
    if (hifiNoiseGate !== undefined) {
        hifiNoiseGate.setThreshold(value);
        console.log('set noisegate threshold to', value, 'dB');
    }
}

const floatView = new Float64Array(1);
const int32View = new Int32Array(floatView.buffer);

// Fast approximation of Math.log2(x)
// for x  > 0.0, returns log2(x)
// for x <= 0.0, returns large negative value
// abs |error| < 2e-4, smooth (exact for x=2^N)
function fastLog2(x) {

    floatView[0] = x;
    let bits = int32View[1];

    // split into mantissa-1.0 and exponent
    let m = (bits & 0xfffff) * (1 / 1048576.0);
    let e = (bits >> 20) - 1023;

    // polynomial for log2(1+x) over x=[0,1]
    let y = (((-0.0821307180 * m + 0.321188984) * m - 0.677784014) * m + 1.43872575) * m;

    // reconstruct result
    return y + e;
}

// Fast approximation of Math.atan2(y, x)
// rel |error| < 4e-5, smooth (exact at octant boundary)
// for y=0 x=0, returns NaN
function fastAtan2(y, x) {
    let ax = Math.abs(x);
    let ay = Math.abs(y);
    let x1 = Math.min(ax, ay) / Math.max(ax, ay);

    // 9th-order odd polynomial approximation to atan(x) over x=[0,1]
    // evaluate using Estrin's method
    let x2 = x1 * x1;
    let x3 = x2 * x1;
    let x4 = x2 * x2;
    let r =  0.024065681985187 * x4 + 0.186155334995372;
    let t = -0.092783165661197 * x4 - 0.332039687921915;
    r = r * x2 + t;
    r = r * x3 + x1;

    // use octant to reconstruct result in [-PI,PI]
    if (ay > ax) r = 1.570796326794897 - r;
    if (x < 0.0) r = 3.141592653589793 - r;
    if (y < 0.0) r = -r;
    return r;
}

function angleWrap(angle) {
    return angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));
}

function setPosition(hifiSource) {
    let dx = hifiSource._x - hifiPosition.x;
    let dy = hifiSource._y - hifiPosition.y;

    let distanceSquared = dx * dx + dy * dy;
    let distance = Math.sqrt(distanceSquared);
    let angle = (distanceSquared < 1e-30) ? 0.0 : fastAtan2(dx, dy);

    let azimuth = angleWrap(angle - hifiPosition.o);

    hifiSource.setPosition(azimuth, distance);
}

function updatePositions(elements) {

    // update the listener
    let e = elements.find(e => e.uid === options.uid);
    if (e !== undefined) {

        // transform canvas to audio coordinates
        hifiPosition.x = (e.x - 0.5) * canvasDimensions.width;
        hifiPosition.y = -(e.y - 0.5) * canvasDimensions.height;
        hifiPosition.o = e.o;
        listenerMetadata(hifiPosition);
    }

    // update the local sources
    elements.forEach(e => {
        if (e.uid < 0) {
            let hifiSource = hifiSources[e.uid];
            if (hifiSource !== undefined) {

                // transform canvas to audio coordinates
                hifiSource._x = (e.x - 0.5) * canvasDimensions.width;
                hifiSource._y = -(e.y - 0.5) * canvasDimensions.height;
                hifiSource._o =  e.o;
                setPosition(hifiSource);
            }
        }
    });
}

class AudioLevel {

    constructor(sourceNode) {
        this.analyserNode = new AnalyserNode(sourceNode.context, { fftSize: 1024 });
        this.buffer = new Float32Array(this.analyserNode.fftSize);
        this.level = 0.0;

        this.sourceNode = sourceNode;
        this.sourceNode.connect(this.analyserNode);
    }

    setSource(sourceNode) {
        this.sourceNode?.disconnect(this.analyserNode);

        this.sourceNode = sourceNode;
        this.sourceNode?.connect(this.analyserNode);
    }

    getLevel() {
        if (!this.sourceNode || this.sourceNode.context.state !== 'running') {
            return this.level = 0.0;
        }

        // compute RMS level
        this.analyserNode.getFloatTimeDomainData(this.buffer);
        let sumSquared = this.buffer.reduce((sum, x) => sum + x * x, 0.0);
        let level = Math.sqrt(sumSquared / this.buffer.length);

        // apply release
        const TC_RELEASE = 0.61;    // -100dB/s @ 48khz/1024
        this.level = Math.max(level, this.level * TC_RELEASE);
        this.level = (this.level > 1e-10) ? this.level : 0.0;

        return this.level;
    }
}

function updateAudioLevel(level, uid) {

    let e = elements.find(e => e.uid === uid);
    if (e !== undefined) {

        let leveldB = 6.02059991 * fastLog2(level);
        e.radius = 0.02 + 0.04 * Math.max(0.0, leveldB + 48) * (1 / 48.0);  // [0.02, 0.06] at [-48dBFS, 0dBFS]
    }
}

function updateAudioLevels() {
    Object.keys(hifiAudioLevels).forEach(uid => {
        updateAudioLevel(hifiAudioLevels[uid].getLevel(), Number(uid));
    });
}

function installSenderTransform() {

    let senders = client._p2pChannel.connection.peerConnection.getSenders();
    let sender = senders.find(e => e.track?.kind === 'audio');

    setupSenderMetadata(sender);
}

function installReceiverTransform(trackId, uid) {

    let receivers = client._p2pChannel.connection.peerConnection.getReceivers();
    let receiver = receivers.find(e => e.track?.id === trackId && e.track?.kind === 'audio');

    setupReceiverMetadata(receiver, uid, sourceMetadata);
}

async function join() {

    await startSpatialAudio();

    // add event listener to play remote tracks when remote user publishs.
    client.on("user-published", handleUserPublished);
    client.on("user-unpublished", handleUserUnpublished);

    // When Agora performs a "tryNext" reconnect, a new SFU peer connection is created and all
    // tracks and transceivers will change. The new tracks are quietly republished/resubscribed
    // and no "user-published" callbacks are triggered. This callback finishes configuring the
    // new tracks and transceivers.
    client.on("media-reconnect-end", async function (uid) {
        if (uid == client.uid) {

            console.warn('RECONNECT for local audioTrack:', uid);
            installSenderTransform();

        } else {

            let user = remoteUsers[uid];
            if (user !== undefined) {

                console.warn('RECONNECT for remote audioTrack:', uid);

                // sourceNode for new WebRTC track
                let mediaStreamTrack = user.audioTrack.getMediaStreamTrack();
                let mediaStream = new MediaStream([mediaStreamTrack]);
                let sourceNode = audioContext.createMediaStreamSource(mediaStream);

                // connect to existing hifiSource
                sourceNode.connect(hifiSources[uid]);

                // connect to existing hifiAudioLevel
                hifiAudioLevels[uid]?.setSource(sourceNode);

                installReceiverTransform(mediaStreamTrack.id, uid);
            }
        }
    });

    // join a channel
    options.uid = await client.join(options.appid, options.channel, options.token || null);
    usernames[options.uid] = options.username;

    //
    // canvas GUI
    //
    let canvas = document.getElementById('canvas');

    elements.push({
        icon: 'listenerIcon',
        x: 0.5 + (hifiPosition.x / canvasDimensions.width),
        y: 0.5 - (hifiPosition.y / canvasDimensions.height),
        o: hifiPosition.o,
        radius: 0.02,
        alpha: 0.5,
        clickable: true,
        uid: options.uid,
    });

    canvasControl = new CanvasControl(canvas, elements, updatePositions);
    canvasControl.draw();

    // create local tracks
    let audioConfig = {
        AEC: isAecEnabled,
        AGC: false,
        ANS: false,
        bypassWebAudio: true,
        encoderConfig: {
            sampleRate: 48000,
            bitrate: 64,
            stereo: false,
        },
    };
    localTracks.audioTrack = await AgoraRTC.createMicrophoneAudioTrack(audioConfig);

    //
    // route mic stream through Web Audio noise gate
    //
    let mediaStreamTrack = localTracks.audioTrack.getMediaStreamTrack();
    let mediaStream = new MediaStream([mediaStreamTrack]);

    let sourceNode = audioContext.createMediaStreamSource(mediaStream);
    let destinationNode = audioContext.createMediaStreamDestination();

    hifiNoiseGate = new NoiseGate(audioContext);
    setThreshold(isMuteEnabled ? 0.0 : threshold.value);

    sourceNode.connect(hifiNoiseGate).connect(destinationNode);

    // compute audio level for this source
    hifiAudioLevels[options.uid] = new AudioLevel(hifiNoiseGate);

    let destinationTrack = destinationNode.stream.getAudioTracks()[0];
    await localTracks.audioTrack._updateOriginMediaStreamTrack(destinationTrack, false);

    // publish local tracks to channel
    await client.publish(Object.values(localTracks));
    console.log("publish success");

    installSenderTransform();

    // on broadcast from remote user, set corresponding username
    client.on("stream-message", (uid, data) => {
        usernames[uid] = (new TextDecoder).decode(data);
        console.log('%creceived stream-message from:', 'color:cyan', usernames[uid]);
    });

    // update GUI with audio levels
    hifiAudioLevelsTimer = setInterval(updateAudioLevels, (1024 / 48000) * 1000);
}

async function leave() {

    for (let trackName in localTracks) {
        let track = localTracks[trackName];
        if (track) {
            track.stop();
            track.close();
            localTracks[trackName] = undefined;
        }
    }

    // remove remote users and player views
    remoteUsers = {};
    $("#remote-playerlist").html("");

    // leave the channel
    await client.leave();

    $("#local-player-name").text("");
    $("#join").attr("disabled", false);
    $("#leave").attr("disabled", true);

    elements.length = 0;

    stopSpatialAudio();

    clearInterval(hifiAudioLevelsTimer);

    console.log("client leaves channel success");
}

function handleUserPublished(user, mediaType) {
    const id = user.uid;
    remoteUsers[id] = user;
    subscribe(user, mediaType);
}

function handleUserUnpublished(user) {
    const id = user.uid;
    delete remoteUsers[id];
    $(`#player-wrapper-${id}`).remove();
    unsubscribe(user);
}

async function subscribe(user, mediaType) {
    const uid = user.uid;

    // subscribe to a remote user
    await client.subscribe(user, mediaType);
    console.log("subscribe uid:", uid);

    //    if (mediaType === 'video') {
    //        const player = $(`
    //      <div id="player-wrapper-${uid}">
    //        <p class="player-name">remoteUser(${uid})</p>
    //        <div id="player-${uid}" class="player"></div>
    //      </div>
    //    `);
    //        $("#remote-playerlist").append(player);
    //        user.videoTrack.play(`player-${uid}`);
    //    }

    if (mediaType === 'audio') {

        //user.audioTrack.play();

        // sourceNode for WebRTC track
        let mediaStreamTrack = user.audioTrack.getMediaStreamTrack();
        let mediaStream = new MediaStream([mediaStreamTrack]);
        let sourceNode = audioContext.createMediaStreamSource(mediaStream);

        // connect to new hifiSource
        let hifiSource = new HRTFInput(audioContext);
        hifiSources[uid] = hifiSource;
        sourceNode.connect(hifiSource);

        // compute audio level for this source
        hifiAudioLevels[uid] = new AudioLevel(sourceNode);

        installReceiverTransform(mediaStreamTrack.id, uid);

        elements.push({
            icon: 'sourceIcon',
            radius: 0.02,
            alpha: 0.5,
            clickable: false,
            uid,
        });
    }

    // broadcast my name
    client.sendStreamMessage((new TextEncoder).encode(usernames[options.uid]));
    console.log('%csent stream-message of:', 'color:cyan', usernames[options.uid]);
}

async function unsubscribe(user) {
    const uid = user.uid;

    hifiSources[uid].disconnect();
    delete hifiSources[uid];
    delete hifiAudioLevels[uid];
    delete usernames[uid];

    // find and remove this uid
    let i = elements.findIndex(e => e.uid === uid);
    if (i > -1) elements.splice(i, 1);

    console.log("unsubscribe uid:", uid);
}

//
// Chrome (as of M100) cannot perform echo cancellation of the Web Audio output.
// As a workaround, a loopback configuration of local peer connections is inserted at the end of the pipeline.
// This should be removed when Chrome implements browser-wide echo cancellation.
// https://bugs.chromium.org/p/chromium/issues/detail?id=687574#c60
//
// let loopback = undefined;
// async function startEchoCancellation(element, context) {

//     loopback = [new _RTCPeerConnection, new _RTCPeerConnection];

//     // connect Web Audio to destination
//     let destination = context.createMediaStreamDestination();
//     hifiLimiter.connect(destination);

//     // connect through loopback peer connections
//     loopback[0].addTrack(destination.stream.getAudioTracks()[0]);
//     loopback[1].ontrack = e => element.srcObject = new MediaStream([e.track]);

//     async function iceGatheringComplete(pc) {
//         return pc.iceGatheringState === 'complete' ? pc.localDescription :
//             new Promise(resolve => {
//                 pc.onicegatheringstatechange = e => { pc.iceGatheringState === 'complete' && resolve(pc.localDescription); };
//             });
//     }

//     // start loopback peer connections
//     let offer = await loopback[0].createOffer();
//     offer.sdp = offer.sdp.replace('useinbandfec=1', 'useinbandfec=1; stereo=1; sprop-stereo=1; maxaveragebitrate=256000');
//     await loopback[0].setLocalDescription(offer);
//     await loopback[1].setRemoteDescription(await iceGatheringComplete(loopback[0]));

//     let answer = await loopback[1].createAnswer();
//     answer.sdp = answer.sdp.replace('useinbandfec=1', 'useinbandfec=1; stereo=1; sprop-stereo=1; maxaveragebitrate=256000');
//     await loopback[1].setLocalDescription(answer);
//     await loopback[0].setRemoteDescription(await iceGatheringComplete(loopback[1]));

//     console.log('Started AEC using loopback peer connections.')
// }

// function stopEchoCancellation() {
//     loopback && loopback.forEach(pc => pc.close());
//     loopback = null;
//     console.log('Stopped AEC.')
// }

async function startSpatialAudio() {

    //
    // audioElement and audioContext are created immediately after a user gesture,
    // to prevent Safari auto-play policy from breaking the audio pipeline.
    //
    audioElement = new Audio();
    try {
        audioContext = new AudioContext({ sampleRate: 48000 });
    } catch (e) {
        console.log('Web Audio API is not supported by this browser.');
        return;
    }
    console.log("Audio callback latency (samples):", audioContext.sampleRate * audioContext.baseLatency);

    let dst = await setupHRTFOutput(audioContext, sourceMetadata);

    if (isAecEnabled && !!window.chrome) {
        // startEchoCancellation(audioElement, audioContext);
    } else {
        // dst.connect(audioContext.destination);
        audioElement.srcObject = dst.stream;
    }

    $("#sound").attr("hidden", false);
    audioElement.play();
}

function stopSpatialAudio() {
    $("#sound").attr("hidden", true);

    Object.values(hifiSources).forEach((hifiSource) => hifiSource.disconnect());
    hifiSources = {};
    hifiAudioLevels = {};

    // stopEchoCancellation();
    shutdownHRTFOutput(audioContext);
    audioContext.close();
}

async function startLocalSound(uid, url, x, y, o) {

    if (uid >= 0) {
        console.warn("ERROR: Local source uid must be < 0!");
        return;
    }

    // load the audio file
    let response = await fetch(url);
    let buffer = await response.arrayBuffer();
    let audioBuffer = await audioContext.decodeAudioData(buffer);

    // create looping source node
    let sourceNode = new AudioBufferSourceNode(audioContext);
    sourceNode.buffer = audioBuffer;
    sourceNode.loop = true;

    // connect to new hifiSource
    let hifiSource = new HRTFInput(audioContext);
    hifiSources[uid] = hifiSource;

    // compute audio level for this source
    hifiAudioLevels[uid] = new AudioLevel(sourceNode);

    // set hifiSource position
    hifiSource._x = x;
    hifiSource._y = y;
    hifiSource._o = o;
    setPosition(hifiSource);

    // add GUI element
    elements.push({
        icon: 'soundIcon',
        x: 0.5 + (x / canvasDimensions.width),
        y: 0.5 - (y / canvasDimensions.height),
        o: o,
        radius: 0.02,
        alpha: 0.5,
        clickable: true,
        uid,
    });

    usernames[uid] = url.substring(url.lastIndexOf("/")+1, url.lastIndexOf("."));

    sourceNode.start();
    console.log('Started local sound:', url);
}

async function stopLocalSound(uid) {

    if (uid >= 0) {
        console.warn("ERROR: Local source uid must be < 0!");
        return;
    }
    let username = usernames[uid];

    hifiSources[uid].disconnect();
    delete hifiSources[uid];
    delete hifiAudioLevels[uid];
    delete usernames[uid];

    // find and remove this uid
    let i = elements.findIndex(e => e.uid === uid);
    if (i > -1) elements.splice(i, 1);

    console.log('Stopped local sound:', username);
}

// collect and display stats
//let statsInterval = setInterval(updateStats, 1000);

function updateStats() {
    let statsText = "";

    // get the client stats
    const clientStats = client.getRTCStats();
    const clientStatsList = [{ description: "Send RTT to Agora", value: clientStats.RTT, unit: "ms" }];
    statsText += `${clientStatsList.map((stat) => `<p style="margin:0">${stat.description}: ${stat.value} ${stat.unit}</p>`).join("")}`;

    // get the local track stats
    const localStats = client.getLocalAudioStats();
    const localStatsList = [{ description: "Send packets lost", value: localStats.sendPacketsLost, unit: "" }];
    statsText += `${localStatsList.map((stat) => `<p style="margin:0">${stat.description}: ${stat.value} ${stat.unit}</p>`).join("")}`;

    Object.keys(remoteUsers).forEach((uid) => {
        // get the remote track stats
        const remoteTracksStats = client.getRemoteAudioStats()[uid];
        const remoteTracksStatsList = [
            { description: "Recv delay", value: Number(remoteTracksStats.receiveDelay).toFixed(0), unit: "ms" },
            { description: "Recv packets lost", value: remoteTracksStats.receivePacketsLost, unit: "" },
        ];
        statsText += `${remoteTracksStatsList.map((stat) => `<p style="margin:0">${uid} ${stat.description}: ${stat.value} ${stat.unit}</p>`).join("")}`;

        // get the remote network stats
        const networkStats = client.getRemoteNetworkQuality()[uid];
        const networkStatsList = [
            { description: "Uplink quality", value: networkStats.uplinkNetworkQuality, unit: "" },
            { description: "Downlink quality", value: networkStats.downlinkNetworkQuality, unit: "" },
        ];
        statsText += `${networkStatsList.map((stat) => `<p style="margin:0">${uid} ${stat.description}: ${stat.value} ${stat.unit}</p>`).join("")}`;
    });

    $("#success-alert").html(statsText);
}
