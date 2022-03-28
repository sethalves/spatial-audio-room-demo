
import { HiFiAudioAPIData, ReceivedHiFiAudioAPIData, Point3D, Quaternion, OtherUserGainMap } from "./HiFiAudioAPIData";
import { HiFiHandedness, WorldFrameConfiguration } from "./HiFiAxisConfiguration";

declare var HIFI_API_VERSION: string;


export enum MuteReason {
    CLIENT = "client",
    ADMIN = "admin",
    INTERNAL = "internal"
}


export class MuteChangedEvent {
    success: boolean;
    targetInputAudioMutedValue: boolean;
    currentInputAudioMutedValue: boolean;
    adminPreventsInputAudioUnmuting: boolean;
    muteReason: MuteReason;

    constructor({
        success,
        targetInputAudioMutedValue,
        currentInputAudioMutedValue,
        adminPreventsInputAudioUnmuting,
        muteReason
    }: {
        success: boolean,
        targetInputAudioMutedValue: boolean,
        currentInputAudioMutedValue: boolean,
        adminPreventsInputAudioUnmuting: boolean,
        muteReason: MuteReason
    }) {
        this.success = success;
        this.targetInputAudioMutedValue = targetInputAudioMutedValue;
        this.currentInputAudioMutedValue = currentInputAudioMutedValue;
        this.adminPreventsInputAudioUnmuting = adminPreventsInputAudioUnmuting;
        this.muteReason = muteReason;
    }
}

export type OnMuteChangedCallback = (muteChangedEvent: MuteChangedEvent) => void;


interface AudionetSetOtherUserGainsForThisConnectionResponse {
    success: boolean,
    reason?: string
}

export interface SetOtherUserGainsForThisConnectionResponse {
    success: boolean,
    error?: string,
    audionetSetOtherUserGainsForThisConnectionResponse?: AudionetSetOtherUserGainsForThisConnectionResponse
}


interface AudionetSetOtherUserGainsForThisConnectionResponse {
    success: boolean,
    reason?: string
}


export interface SetOtherUserGainsForThisConnectionResponse {
    success: boolean,
    error?: string,
    audionetSetOtherUserGainsForThisConnectionResponse?: AudionetSetOtherUserGainsForThisConnectionResponse
}

export type SetOtherUserGainForThisConnectionResponse = SetOtherUserGainsForThisConnectionResponse;


export enum AvailableUserDataSubscriptionComponents {
    Position = "Position",
    Orientation = "Orientation (Quaternion)",
    VolumeDecibels = "Volume (Decibels)",
    IsStereo = "IsStereo"
}


export class UserDataSubscription {
    providedUserID: string;
    components: Array<AvailableUserDataSubscriptionComponents>;
    callback: Function;
    constructor({
        providedUserID = null,
        components,
        callback
    }: {
        providedUserID?: string,
        components: Array<AvailableUserDataSubscriptionComponents>,
        callback: Function
    }) {
        this.providedUserID = providedUserID;
        this.components = components;
        this.callback = callback;
    }
}


export enum HiFiConnectionStates {
    Disconnected = "Disconnected",
    Connecting = "Connecting",
    Connected = "Connected",
    InputConnected = "InputConnected",
    Reconnecting = "Reconnecting",
    Disconnecting = "Disconnecting",
    Failed = "Failed",
    Unavailable = "Unavailable"
};

export enum HiFiUserDataStreamingScopes {
    None = "none",
    Peers = "peers",
    All = "all"
};

export interface ConnectionRetryAndTimeoutConfig {
  autoRetryInitialConnection?: boolean;
  maxSecondsToSpendRetryingInitialConnection?: number;
  autoRetryOnDisconnect?: boolean;
  maxSecondsToSpendRetryingOnDisconnect?: number;
  pauseBetweenRetriesMS?: number;
  timeoutPerConnectionAttemptMS?: number;
};


export interface HiFiConnectionAttemptResult {
    success: boolean,
    error?: string,
    audionetInitResponse?: any,
    disableReconnect?: boolean;
}


export class HiFiCommunicator {

    onUsersDisconnected: Function;
    onConnectionStateChanged: Function;

    private _currentHiFiConnectionState: HiFiConnectionStates = HiFiConnectionStates.Disconnected;
    public getConnectionState(): HiFiConnectionStates {
        return this._currentHiFiConnectionState;
    }

    constructor({
        initialHiFiAudioAPIData = new HiFiAudioAPIData(),
        onConnectionStateChanged,
        onUsersDisconnected,
        transmitRateLimitTimeoutMS = 50,
        userDataStreamingScope = HiFiUserDataStreamingScopes.All,
        worldFrameConfig,
        onMuteChanged,
        connectionRetryAndTimeoutConfig
    }: {
        initialHiFiAudioAPIData?: HiFiAudioAPIData,
        onConnectionStateChanged?: Function,
        onUsersDisconnected?: Function,
        transmitRateLimitTimeoutMS?: number,
        userDataStreamingScope?: HiFiUserDataStreamingScopes,
        worldFrameConfig?: WorldFrameConfiguration,
        onMuteChanged?: OnMuteChangedCallback,
        connectionRetryAndTimeoutConfig?: ConnectionRetryAndTimeoutConfig
    } = {}) {
    }


    async disconnectFromHiFiAudioAPIServer(): Promise<string> {
        return new Promise<string>((resolve) => {
        });
    }


    async setOtherUserGainForThisConnection(visitIdHash: string, gain: number):
    Promise<SetOtherUserGainForThisConnectionResponse> {
        return new Promise<SetOtherUserGainForThisConnectionResponse>((resolve) => {
        });
    }


    async setOtherUserGainsForThisConnection(otherUserGainMap: OtherUserGainMap):
    Promise<SetOtherUserGainsForThisConnectionResponse> {
        return new Promise<SetOtherUserGainsForThisConnectionResponse>((resolve) => {
        });
    }


    getOutputAudioMediaStream(): MediaStream {
        return new MediaStream();
    }


    async setInputAudioMediaStream(newInputAudioMediaStream: MediaStream, isStereo: boolean = false): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
        });
    }


    async setInputAudioMuted(isMuted: boolean): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
        });
    }


    getCommunicatorInfo(): any {
    }


    updateUserDataAndTransmit(newUserData: any): string {
        return "";
    }

    addUserDataSubscription(newSubscription: UserDataSubscription): void {
    }
}
