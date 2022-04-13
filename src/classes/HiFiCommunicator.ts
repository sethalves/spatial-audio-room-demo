
import AgoraRTC, {
    IAgoraRTCClient,
    UID,
    IMicrophoneAudioTrack,
    IAgoraRTCRemoteUser
} from "agora-rtc-sdk-ng";
import { patchRTCPeerConnection } from './patch-rtc-peer-connection';

patchRTCPeerConnection();


export interface HiFiConnectionAttemptResult {
    success: boolean,
    error?: string,
    audionetInitResponse?: any,
    disableReconnect?: boolean;
}


interface AudioWorkletNodeMeta extends AudioWorkletNode {
    _x? : number,
    _y? : number
}

interface IAgoraRTCRemoteUserMeta extends IAgoraRTCRemoteUser {
    _x? : number,
    _y? : number
}


interface TransformStreamWithID extends TransformStream {
    uid? : UID | undefined
}


interface RTCConfiguration {
    iceServers?: RTCIceServer[] | undefined;
    iceTransportPolicy?: RTCIceTransportPolicy | undefined; // default = 'all'
    bundlePolicy?: RTCBundlePolicy | undefined; // default = 'balanced'
    rtcpMuxPolicy?: RTCRtcpMuxPolicy | undefined; // default = 'require'
    peerIdentity?: string | undefined; // default = null
    certificates?: RTCCertificate[] | undefined;
    iceCandidatePoolSize?: number | undefined; // default = 0
    encodedInsertableStreams?: boolean | undefined;
}


// Agora this.client with _p2pChannel exposed
interface IAgoraRTCClientOpen extends IAgoraRTCClient {
    _p2pChannel? : any | undefined
}


interface AgoraClientOptions {
    appid?: string | undefined,
    channel?: string | undefined,
    token?: string | undefined
}

// RTC with insertable stream support
interface RTCRtpSenderIS extends RTCRtpSender {
    createEncodedStreams : Function
}
interface RTCRtpReceiverIS extends RTCRtpReceiver {
    createEncodedStreams : Function
}


interface IMicrophoneAudioTrackOpen extends IMicrophoneAudioTrack {
    _updateOriginMediaStreamTrack? : Function | undefined
}
interface LocalTracks {
    audioTrack: IMicrophoneAudioTrackOpen
}


declare var HIFI_API_VERSION: string;


// Fast approximation of Math.atan2(y, x)
// rel |error| < 4e-5, smooth (exact at octant boundary)
// for y=0 x=0, returns NaN
function fastAtan2(y : number, x : number) : number {
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


export class HiFiCommunicator {

    roomDimensions = {
        width: 8,
        height: 2.5,
        depth: 8,
    };


    audioElement : HTMLAudioElement;
    audioContext : AudioContext;

    hifiNoiseGate : AudioWorkletNode = undefined;  // mic stream connects here
    hifiListener : AudioWorkletNodeMeta = undefined;   // hifiSource connects here
    hifiLimiter : AudioWorkletNode = undefined;    // additional sounds connect here

    uid: UID; // this client's ID (the listener's ID)

    options : AgoraClientOptions = {
        appid: null,
        channel: null,
        token: null
    };

    client : IAgoraRTCClientOpen = AgoraRTC.createClient({
        mode: "rtc",
        codec: "vp8"
    });

    localTracks : LocalTracks = {
        //videoTrack: null,
        audioTrack: null
    };

    remoteUsers: { [uid: string] : IAgoraRTCRemoteUserMeta; } = {};

    audioConfig = {
        AEC: false,
        AGC: false,
        ANS: false,
        bypassWebAudio: true,
        encoderConfig: {
            sampleRate: 48000,
            bitrate: 64,
            stereo: false,
        },
    };

    onRemoteUserJoined: Function;
    onRemoteUserLeft: Function;
    onRemoteUserMoved: Function;


    constructor({
        onRemoteUserJoined,
        onRemoteUserLeft,
        onRemoteUserMoved
    }: {
        onRemoteUserJoined?: Function,
        onRemoteUserLeft?: Function,
        onRemoteUserMoved?: Function
    } = {}) {
        if (onRemoteUserJoined) this.onRemoteUserJoined = onRemoteUserJoined;
        if (onRemoteUserLeft) this.onRemoteUserLeft = onRemoteUserLeft;
        if (onRemoteUserMoved) this.onRemoteUserMoved = onRemoteUserMoved;
    }

    async connect(appid: string, channelName: string): Promise<string> {

        this.options.appid = appid;
        this.options.token = null;
        this.options.channel = channelName;

        await this.join();
        return Promise.resolve("" + this.uid);
    }


    // async setInputAudioMuted(isMuted: boolean): Promise<boolean> {
    //     return Promise.resolve(true);
    // }


    setThreshold(value : number) {
        if (this.hifiNoiseGate !== undefined) {
            this.hifiNoiseGate.parameters.get('threshold').value = value;
            console.log('set noisegate threshold to', value, 'dB');
        }
    }

    private setPosition(hifiSource : AudioWorkletNodeMeta) {
        let dx = hifiSource._x - this.hifiListener._x;
        let dy = hifiSource._y - this.hifiListener._y;

        //let azimuth = angle_wrap(atan2f(dx, dy) - avatarOrientationRadians);

        let distanceSquared = dx * dx + dy * dy;
        let distance = Math.sqrt(distanceSquared);
        let azimuth = (distanceSquared < 1e-30) ? 0.0 : fastAtan2(dx, dy);

        hifiSource.parameters.get('azimuth').value = azimuth;
        hifiSource.parameters.get('distance').value = distance;
    }

    setListenerPosition(x : number, y : number) {
        this.hifiListener._x = (x - 0.5) * this.roomDimensions.width;
        this.hifiListener._y = -(y - 0.5) * this.roomDimensions.depth;
    }

    private async join() {
        await this.startSpatialAudio();

        // add event listener to play remote tracks when remote user publishs.
        this.client.on("user-published", this.handleUserPublished);
        this.client.on("user-unpublished", this.handleUserUnpublished);

        // join a channel and create local tracks
        this.uid = await this.client.join(this.options.appid, this.options.channel, this.options.token || null);

        console.log("QQQQQQQQQQQ get uid from agora: " + this.uid);

        this.localTracks.audioTrack = await AgoraRTC.createMicrophoneAudioTrack(this.audioConfig);

        //
        // route mic stream through Web Audio noise gate
        //
        let mediaStreamTrack = this.localTracks.audioTrack.getMediaStreamTrack();
        let mediaStream = new MediaStream([mediaStreamTrack]);

        let sourceNode = this.audioContext.createMediaStreamSource(mediaStream);
        let destinationNode = this.audioContext.createMediaStreamDestination()
        this.hifiNoiseGate = new AudioWorkletNode(this.audioContext, 'wasm-noise-gate');

        sourceNode.connect(this.hifiNoiseGate).connect(destinationNode);

        let destinationTrack = destinationNode.stream.getAudioTracks()[0];
        await this.localTracks.audioTrack._updateOriginMediaStreamTrack(destinationTrack, false);

        // publish local tracks to channel
        await this.client.publish(Object.values(this.localTracks));
        console.log("publish success");

        //
        // insertable streams
        //
        let senders : Array<RTCRtpSenderIS> = this.client._p2pChannel.connection.peerConnection.getSenders();
        senders.forEach(sender => this.senderTransform(sender));

        //
        // HACK! set user radius based on volume level
        // TODO: reimplement in a performant way...
        //
        // AgoraRTC.setParameter("AUDIO_VOLUME_INDICATION_INTERVAL", 20);
        // this.client.enableAudioVolumeIndicator();
        // this.client.on("volume-indicator", volumes => {
        //     volumes.forEach((volume, index) => {
        //         let e = this.elements.find(e => e.uid === volume.uid);
        //         if (e !== undefined)
        //             e.radius = 0.02 + 0.04 * volume.level/100;
        //     });
        // })

        // this.tellAppAboutUserData();
    }

    private senderTransform(sender : RTCRtpSenderIS) {
        const senderStreams = sender.createEncodedStreams();
        const readableStream = senderStreams.readable;
        const writableStream = senderStreams.writable;
        const transformStream = new TransformStream({
            start() { console.log('installed sender transform'); },
            transform(encodedFrame, controller) {
                if (sender.track.kind === "audio") {

                    let src = new DataView(encodedFrame.data);
                    let len = encodedFrame.data.byteLength;

                    // create dst buffer with 4 extra bytes
                    let dst = new DataView(new ArrayBuffer(len + 4));

                    // copy src data
                    for (let i = 0; i < len; ++i) {
                        dst.setInt8(i, src.getInt8(i));
                    }

                    let qx : number = 0;
                    let qy : number = 0;

                    // insert metadata at the end
                    if (this.hifiListener) {
                        qx = Math.round(this.hifiListener._x * 256.0); // x in Q7.8
                        qy = Math.round(this.hifiListener._y * 256.0); // y in Q7.8
                    }

                    dst.setInt16(len + 0, qx);
                    dst.setInt16(len + 2, qy);

                    encodedFrame.data = dst.buffer;
                }
                controller.enqueue(encodedFrame);
            },
        });
        readableStream.pipeThrough(transformStream).pipeTo(writableStream);
    }


    private receiverTransform(receiver : RTCRtpReceiverIS, uid : UID) {
        const receiverStreams = receiver.createEncodedStreams();
        const readableStream = receiverStreams.readable;
        const writableStream = receiverStreams.writable;
        const transformStream : TransformStreamWithID = new TransformStream({
            start() { console.log('installed receiver transform for uid:', uid); },
            transform(encodedFrame, controller) {
                if (receiver.track.kind === "audio") {

                    let src = new DataView(encodedFrame.data);
                    let len = encodedFrame.data.byteLength - 4;

                    // create dst buffer with 4 fewer bytes
                    let dst = new DataView(new ArrayBuffer(len));

                    // copy src data
                    for (let i = 0; i < len; ++i) {
                        dst.setInt8(i, src.getInt8(i));
                    }

                    // extract metadata at the end
                    let x = src.getInt16(len + 0) * (1/256.0);
                    let y = src.getInt16(len + 2) * (1/256.0);

                    let remoteUser : IAgoraRTCRemoteUserMeta = this.remoteUsers[uid];
                    if (remoteUser._x != x || remoteUser._y != y) {
                        this.onRemoteUserMoved(uid,
                                               0.5 + (x / this.roomDimensions.width),
                                               0.5 - (y / this.roomDimensions.depth));
                    }

                    encodedFrame.data = dst.buffer;
                }
                controller.enqueue(encodedFrame);
            },
        });

        transformStream.uid = uid;

        readableStream.pipeThrough(transformStream).pipeTo(writableStream);
    }


    async leave() {
        if (this.localTracks.audioTrack) {
            this.localTracks.audioTrack.stop();
            this.localTracks.audioTrack.close();
            this.localTracks.audioTrack = undefined;
        }

        this.remoteUsers = {};

        // leave the channel
        await this.client.leave();

        this.stopSpatialAudio();

        console.log("this.client leaves channel success");
    }


    private handleUserPublished(user : IAgoraRTCRemoteUser, mediaType : string) {
        const id : UID = user.uid;
        this.remoteUsers[id] = user;
        this.remoteUsers[id]._x = 0;
        this.remoteUsers[id]._y = 0;
        this.subscribe(user, mediaType);
    }


    private handleUserUnpublished(user : IAgoraRTCRemoteUser) {
        const id : UID = user.uid;
        delete this.remoteUsers[id];
        this.unsubscribe(user);
    }


    private async subscribe(user : IAgoraRTCRemoteUser, mediaType : string) {
        const uid = user.uid;

        // subscribe to a remote user
        if (mediaType == "audio") {
            await this.client.subscribe(user, mediaType);
            console.log("subscribe uid:", uid);
        }

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

            let mediaStreamTrack = user.audioTrack.getMediaStreamTrack();
            let mediaStream = new MediaStream([mediaStreamTrack]);
            let sourceNode = this.audioContext.createMediaStreamSource(mediaStream);

            let hifiSource : AudioWorkletNodeMeta = new AudioWorkletNode(this.audioContext, 'wasm-hrtf-input');
            sourceNode.connect(hifiSource).connect(this.hifiListener);

            //
            // insertable streams
            //
            let receivers : Array<RTCRtpReceiverIS> = this.client._p2pChannel.connection.peerConnection.getReceivers();
            let receiver : RTCRtpReceiverIS = receivers.find(r => r.track.id === mediaStreamTrack.id);
            this.receiverTransform(receiver, uid);

            this.onRemoteUserJoined(uid);
        }
    }


    private async unsubscribe(user: IAgoraRTCRemoteUser) {
        const uid = user.uid;

        this.onRemoteUserLeft(uid);

        console.log("unsubscribe uid:", uid);
    }


    private async startSpatialAudio() {

        this.audioElement = new Audio();

        try {
            this.audioContext = new AudioContext({ sampleRate: 48000 });
        } catch (e) {
            console.log('Web Audio is not supported by this browser.');
            return;
        }

        console.log("Audio callback latency (samples):", this.audioContext.sampleRate * this.audioContext.baseLatency);

        await this.audioContext.audioWorklet.addModule('HifiProcessor.js');

        this.hifiListener = new AudioWorkletNode(this.audioContext, 'wasm-hrtf-output', {outputChannelCount : [2]});
        // this.hifiListener._x = 2.0 * Math.random() - 1.0; // initial position
        // this.hifiListener._y = 2.0 * Math.random() - 1.0;
        this.hifiLimiter = new AudioWorkletNode(this.audioContext, 'wasm-limiter');
        this.hifiListener.connect(this.hifiLimiter).connect(this.audioContext.destination);

        this.audioElement.play();
    }


    private stopSpatialAudio() {
        this.audioContext.close();
    }
}