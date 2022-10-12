
import {
    HiFiRemoteUser,
    HiFiTransport,
    HiFiMicrophoneAudioTrackInitConfig,
    HiFiCameraVideoTrackInitConfig,
    RTCRtpReceiverIS,
    RTCRtpSenderIS,
    LocalTrack
} from "./hifi-transport.js"


interface RTCRemoteUser extends HiFiRemoteUser {
    contacted : boolean;
    peerConnection : RTCPeerConnection;
    toPeer : RTCDataChannel;
    fromPeer : (peerID : string, data : Uint8Array) => void;
    sdp : (sdpType: string, sdp: string /*RTCSessionDescriptionInit*/) => void;
    ice : (candidate: string, sdpMid: string, sdpMLineIndex: number) => void;
    doStop : boolean;
}


// export class P2PLocalCameraVideoTrack extends MediaStream implements LocalCameraVideoTrack {
//     stop : () => {
//     },

//     close : () => {
//     },

//     play : (videoEltID : string) => {
//     }
// }


// export class P2PLocalMicrophoneAudioTrack extends MediaStream implements LocalMicrophoneAudioTrack {
//     getMediaStreamTrack : () => {
//         return this.getAudioTracks()[0]
//     },

//     stop : () => {
//     },

//     close : () => {
//     },

//     updateOriginMediaStreamTrack : (replacement : MediaStreamTrack) => {
//         this.removeTrack(this.getMediaStreamTrack());
//         this.addTrack(destinationTrack);
//         return new Promise<void>((resolve) => {
//             resolve();
//         });
//     }
// }



export class HiFiTransportP2P implements HiFiTransport {

    private debugRTC = false;

    private signalingURL : URL;
    private webSocket : WebSocket;
    private localUID : string;

    private onUserPublished : any;
    private onUserUnpublished : any;
    private onStreamMessage : any;
    private onVolumeLevelChange : any;

    private remoteUsers : { [uid: string] : RTCRemoteUser; } = {};

    private micTrack : MediaStream;
    private cameraTrack : MediaStream;
    
    constructor() {
        this.signalingURL = new URL(window.location.href)
        this.signalingURL.pathname = "/token-server";
        this.signalingURL.protocol = "wss";
    }

    join(appID : string, channel : string, token : string, uid : string) : Promise<string> {

        this.localUID = uid;

        this.webSocket = new WebSocket(this.signalingURL.href);
        this.webSocket.onopen = async (event) => {
            this.webSocket.send(JSON.stringify({
                "message-type": "join-p2p-channel",
                "uid": "" + uid,
                "channel": channel
            }));
        }

        this.webSocket.onmessage = async (event) => {
            // console.log("got websocket message: ", event.data);
            let msg = JSON.parse(event.data);
            if (msg["message-type"] == "connect-with-peer") {
                let otherUID = msg["uid"];
                let remoteUser : RTCRemoteUser;
                if (this.remoteUsers[ otherUID ]) {
                    console.log("XXX found existing remote-user " + otherUID);
                    remoteUser = this.remoteUsers[ otherUID ];
                } else {
                    remoteUser = {
                        uid: otherUID,
                        contacted: false,
                        peerConnection: undefined,
                        toPeer : undefined,
                        fromPeer : (peerID : string, data : Uint8Array) => {
                            console.log("got data-channel data from peer");
                            if (this.onStreamMessage) {
                                this.onStreamMessage(otherUID, data);
                            }
                        },
                        sdp : undefined,
                        ice : undefined,
                        doStop : false,
                        audioTrack : undefined,
                        videoTrack : undefined,
                        hasAudio : false,
                        hasVideo : false,
                        getAudioSender : function() {
                            return this.peerConnection.getSenders()[0];
                        },
                        getAudioReceiver : function() {
                            let receivers : Array<RTCRtpReceiverIS> = this.peerConnection.getReceivers();
                            let receiver : RTCRtpReceiverIS =
                                receivers.find(e => e.track?.id === this.audioTrack.id && e.track?.kind === 'audio');
                            return receiver;
                        },
                        getAudioTrack : function() {
                            return this.audioTrack;
                        }
                    };
                    console.log("XXX created new remote-user " + otherUID);
                    this.remoteUsers[ otherUID ] = remoteUser;
                }

                this.contactPeer(remoteUser,
                                 async (peerID : string, event : RTCTrackEvent) => {
                                     // on audio-track
                                     console.log("XXXXX got stream");
                                     console.log("got audio track from peer, " + event.streams.length + " streams.");
                                     remoteUser.audioTrack = event.track;
                                     remoteUser.hasAudio = true;

                                     if (this.onUserPublished) {
                                         this.onUserPublished(remoteUser, "audio");
                                     }

                                 },
                                 (peerID : string, event : RTCDataChannelEvent) => {
                                     // on data-channel
                                     console.log("XXXXX got data-channel event");
                                 });


                // this triggers negotiation-needed on the peer-connection
                // localTracks.audioTrack.getAudioTracks().forEach(track => {
                //     remoteUser.peerConnection.addTrack(track, localTracks.audioTrack);
                // });
                if (this.micTrack) {
                    console.log("XXX adding track to peer-connection (A) for " + uid);
                    remoteUser.peerConnection.addTrack(this.micTrack.getAudioTracks()[ 0 ]);
                } else {
                    console.log("XXX no mic track yet");
                }

            } else if (msg["message-type"] == "ice-candidate") {
                let fromUID = msg["from-uid"];
                if (this.remoteUsers[ fromUID ]) {
                    this.remoteUsers[ fromUID ].ice(msg["candidate"], msg["sdpMid"], msg["sdpMLineIndex"]);
                } else {
                    console.log("error -- got ice from unknown remote user:" + fromUID);
                }

            } else if (msg["message-type"] == "sdp") {
                let fromUID = msg["from-uid"];
                if (this.remoteUsers[ fromUID ]) {
                    this.remoteUsers[ fromUID ].sdp(msg["offer"] ? "offer" : "answer", msg["sdp"]);
                } else {
                    console.log("error -- git ice from unknown remote user:" + fromUID);
                }

            } else if (msg["message-type"] == "disconnect-from-peer") {
                let otherUID = msg["uid"];
                delete this.remoteUsers[ otherUID ];
                if (this.onUserUnpublished) {
                    this.onUserUnpublished("" + otherUID);
                }
            }
        }

        return new Promise<string>((resolve) => {
            resolve(this.localUID);
        });
    }


    async leave(willRestart? : boolean) : Promise<void> {

        if (this.webSocket) {
            this.webSocket.close();
        }

        let meter = document.getElementById('my-peak-meter');
        if (meter) {
            while (meter.firstChild) {
                meter.removeChild(meter.firstChild);
            }
        }


        console.log("hifi-audio: leave()");

        this.micTrack = undefined;
        this.cameraTrack = undefined;

        if (this.onUserUnpublished) {
            for (let uid in this.remoteUsers) {
                this.onUserUnpublished("" + uid);
            }
        }

        this.remoteUsers = {};

        return new Promise<void>((resolve) => {
            resolve();
        });
    }


    async rejoin() : Promise<void> {
        console.log("XXX write p2p rejoin");

        return new Promise<void>((resolve) => {
            resolve();
        });
    }


    on(eventName : string, callback : Function) {
        if (eventName == "user-published") {
            this.onUserPublished = callback;
        } else if (eventName == "user-unpublished") {
            this.onUserUnpublished = callback;
        } else if (eventName == "broadcast-received") {
            this.onStreamMessage = callback;
        } else if (eventName == "volume-level-change") {
            this.onVolumeLevelChange = callback;
        }
    }

    publish(localTracks : Array<LocalTrack>) : Promise<void> {
        console.log("XXX in publish mic-track...");

        for (let localTrack of localTracks) {
            let track = localTrack.getMediaStreamTrack();
            console.log("  track.kind=" + track.kind);
            if (true || track.kind == "audio") { // XXX
                if (!this.micTrack) {
                    this.micTrack = new MediaStream();
                }

                console.log("XXXXXX HERE " + JSON.stringify(track));
                this.micTrack.addTrack(track);

                for (let uid in this.remoteUsers) {
                    let remoteUser = this.remoteUsers[ uid ];
                    console.log("XXX adding track to peer-connection (B) for " + uid);
                    remoteUser.peerConnection.addTrack(this.micTrack.getAudioTracks()[ 0 ]);
                }
            }
        }

        return new Promise<void>((resolve) => {
            resolve();
        });
    }


    unpublish(localTracks : Array<LocalTrack>) : Promise<void> {
        console.log("XXX write p2p unpublish");
        return new Promise<void>((resolve) => {
            resolve();
        });
    }


    subscribe(user : HiFiRemoteUser, mediaType : string) : Promise<void> {
        return new Promise<void>((resolve) => {
            resolve();
        });
    }


    unsubscribe(user : HiFiRemoteUser) : Promise<void> {
        return new Promise<void>((resolve) => {
            resolve();
        });
    }


    getSharedAudioReceiver() : RTCRtpReceiverIS {
        return null;
    }

    getSharedAudioSender() : RTCRtpSenderIS {
        return null;
    }


    async createMicrophoneAudioTrack(audioConfig : HiFiMicrophoneAudioTrackInitConfig) : Promise<LocalTrack> {
        let audioTrack : MediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                autoGainControl: true,
                noiseSuppression: true,
                sampleRate: 48000,
                channelCount: { exact:1 }
            },
            video: false // video
        });

        let micTrack = {
            stop : () => { /* audioTrack.stop(); */ },
            close : () => { /* audioTrack.close(); */ },
            play : (videoEltID : string) => { },
            getMediaStreamTrack : () => { return audioTrack.getAudioTracks()[0]; },
            updateOriginMediaStreamTrack : (replacement : MediaStreamTrack) => {
                audioTrack.removeTrack(audioTrack.getAudioTracks()[0]);
                audioTrack.addTrack(replacement);
                return new Promise<void>((resolve) => {
                    resolve();
                });
            }
        };

        return new Promise<LocalTrack>((resolve) => {
            resolve(micTrack);
        });
    }

    async createCameraVideoTrack(videoConfig : HiFiCameraVideoTrackInitConfig) : Promise<LocalTrack> {
        return new Promise<LocalTrack>((resolve) => {
            resolve(null);
        });
    }

    
    private contactPeer(remoteUser : RTCRemoteUser,
                        onAudioTrack : (peerID : string, event : RTCTrackEvent) => void,
                        onDataChannel : (peerID : string, event : RTCDataChannelEvent) => void) {

        let iceQueue : RTCIceCandidate[] = [];

        if (remoteUser.contacted) {
            return;
        }
        remoteUser.contacted = true;

        console.log("I am " + this.localUID + ", contacting peer " + remoteUser.uid);

        remoteUser.peerConnection = new RTCPeerConnection({
	        iceServers: [
		        {
			        urls: "stun:stun.l.google.com:19302",
		        },

		        // {
		        //     urls: "turn:some.domain.com:3478",
		        //     credential: "turn-password",
		        //     username: "turn-username"
		        // },

	        ],
        });

        remoteUser.peerConnection.onconnectionstatechange = (event) => {
            if (this.debugRTC) {
                switch(remoteUser.peerConnection.connectionState) {
                    case "connected":
                        // The connection has become fully connected
                        console.log("connection-state is now connected");
                        break;
                    case "disconnected":
                        console.log("connection-state is now disconnected");
                        break;
                    case "failed":
                        // One or more transports has terminated unexpectedly or in an error
                        console.log("connection-state is now failed");
                        break;
                    case "closed":
                        // The connection has been closed
                        console.log("connection-state is now closed");
                        break;
                }
            }
        }


        remoteUser.peerConnection.ondatachannel = (event : RTCDataChannelEvent) => {

            remoteUser.toPeer = event.channel;
            remoteUser.toPeer.binaryType = "arraybuffer";

            remoteUser.toPeer.onmessage = (event : MessageEvent) => {
                remoteUser.fromPeer(remoteUser.uid, new Uint8Array(event.data));
            };

            remoteUser.toPeer.onopen = (event) => {
                if (this.debugRTC) {
                    console.log("data-channel is open");
                }
            };

            remoteUser.toPeer.onclose = (event) => {
                if (this.debugRTC) {
                    console.log("data-channel is closed");
                }
            };

            onDataChannel(remoteUser.uid, event);
        };


        remoteUser.peerConnection.ontrack = (event : RTCTrackEvent) => {
            onAudioTrack(remoteUser.uid, event);
        };


        remoteUser.peerConnection.addEventListener("icegatheringstatechange", ev => {
            if (this.debugRTC) {
                switch(remoteUser.peerConnection.iceGatheringState) {
                    case "new":
                        /* gathering is either just starting or has been reset */
                        console.log("ice-gathering state-change to new: " + JSON.stringify(ev));
                        break;
                    case "gathering":
                        /* gathering has begun or is ongoing */
                        console.log("ice-gathering state-change to gathering: " + JSON.stringify(ev));
                        break;
                    case "complete":
                        /* gathering has ended */
                        console.log("ice-gathering state-change to complete: " + JSON.stringify(ev));
                        break;
                }
            }
        });


        remoteUser.peerConnection.onicecandidate = (event : RTCPeerConnectionIceEvent) => {
            // the local WebRTC stack has discovered another possible address for the local machine.
            // send this to the remoteUser so it can try this address out.
            if (event.candidate) {
                if (this.debugRTC) {
                    console.log("local ice candidate: " + JSON.stringify(event.candidate));
                }
                this.webSocket.send(JSON.stringify({
                    "message-type": "ice-candidate",
                    "from-uid": "" + this.localUID,
                    "to-uid": remoteUser.uid,
                    "candidate": event.candidate.candidate,
                    "sdpMid": event.candidate.sdpMid,
                    "sdpMLineIndex": event.candidate.sdpMLineIndex
                }));

            } else {
                if (this.debugRTC) {
                    console.log("done with local ice candidates");
                }
            }
        };


        remoteUser.peerConnection.addEventListener("negotiationneeded", ev => {
            //        if (debugRTC) {
            console.log("got negotiationneeded for remoteUser " + remoteUser.uid);
            //        }

            if (remoteUser.uid > this.localUID) { // avoid glare
                if (this.debugRTC) {
                    console.log("creating RTC offer SDP...");
                }
                remoteUser.peerConnection.createOffer()
                    .then((offer : RTCSessionDescription) => {
                        remoteUser.peerConnection.setLocalDescription(offer)
                            .then(() => {
                                this.webSocket.send(JSON.stringify({
                                    "message-type": "sdp",
                                    "from-uid": "" + this.localUID,
                                    "to-uid": remoteUser.uid,
                                    "sdp": offer.sdp,
                                    "offer": true
                                }));
                            })
                            .catch((err : any) => console.error(err));
                    })
                    .catch((err : any) => console.error(err));
            } else {
                if (this.debugRTC) {
                    console.log("waiting for peer to create RTC offer...");
                }
            }

        }, false);


        remoteUser.sdp = (sdpType: string, sdp: string /*RTCSessionDescriptionInit*/) => {
            if (this.debugRTC) {
                console.log("got sdp from remoteUser: " + sdpType);
            }

            // forceBitrateUp(sdp);

            remoteUser.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: sdpType as RTCSdpType, sdp: sdp }))
                .then(() => {
                    if (this.debugRTC) {
                        console.log("remote description is set\n");
                    }

                    while (iceQueue.length > 0) {
                        let cndt = iceQueue.shift();
                        if (this.debugRTC) {
                            console.log("adding ice from queue: " + JSON.stringify(cndt));
                        }
                        remoteUser.peerConnection.addIceCandidate(cndt);
                    }


                    if (sdpType == "offer") {
                        remoteUser.peerConnection.createAnswer()
                            .then((answer : RTCSessionDescription) => {
                                if (this.debugRTC) {
                                    console.log("answer is created\n");
                                }
                                let stereoAnswer = new RTCSessionDescription({
                                    type: answer.type,
                                    sdp: answer.sdp // forceStereoDown(answer.sdp)
                                });
                                return remoteUser.peerConnection.setLocalDescription(stereoAnswer).then(() => {
                                    this.webSocket.send(JSON.stringify({
                                        "message-type": "sdp",
                                        "from-uid": "" + this.localUID,
                                        "to-uid": remoteUser.uid,
                                        "sdp": stereoAnswer.sdp,
                                        "offer": false
                                    }));
                                }).catch((err : any) => console.error(err));
                            })
                    }
                })
        }


        remoteUser.ice = (candidate : string, sdpMid : string, sdpMLineIndex : number) => {
            if (this.debugRTC) {
                console.log("got ice candidate from remoteUser: " + JSON.stringify(candidate));
            }

            let cndt = new RTCIceCandidate({
                candidate: candidate,
                sdpMid: sdpMid,
                sdpMLineIndex: sdpMLineIndex,
                usernameFragment: "",
            });

            if (!remoteUser.peerConnection ||
                !remoteUser.peerConnection.remoteDescription ||
                !remoteUser.peerConnection.remoteDescription.type) {
                iceQueue.push(cndt);
            } else {
                remoteUser.peerConnection.addIceCandidate(cndt);
            }
        }


        if (remoteUser.uid > this.localUID) {
            remoteUser.toPeer = remoteUser.peerConnection.createDataChannel(this.localUID + "-to-" + remoteUser.uid);
            remoteUser.toPeer.onmessage = (event : MessageEvent) => {
                remoteUser.fromPeer(remoteUser.uid, new Uint8Array(event.data));
            };
        }
    }


    sendBroadcastMessage(msg : Uint8Array) : boolean {
        var msgString = new TextDecoder().decode(msg);
        console.log("hifi-audio: send broadcast message: " + JSON.stringify(msgString));

        for (let uid in this.remoteUsers) {
            if (this.remoteUsers[ uid ].toPeer) {
                this.remoteUsers[ uid ].toPeer.send(msg);
            }
        }

        return true;
    }


    renewToken(token : string) : Promise<void> {
        return new Promise<void>((resolve) => {
            resolve();
        });
    }
}
