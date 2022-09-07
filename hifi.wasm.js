//
//  Created by Ken Cooke on 3/11/22.
//  Copyright 2022 High Fidelity, Inc.
//
//  The contents of this file are PROPRIETARY AND CONFIDENTIAL, and may not be
//  used, disclosed to third parties, copied or duplicated in any form, in whole
//  or in part, without the prior written consent of High Fidelity, Inc.
//

const NUM_FRAMES = 128;

function interleave(src, dst, N) {
    for (let i = 0; i < N; i++) {
        dst[2 * i + 0] = src[0][i];
        dst[2 * i + 1] = src[1][i];
    }
}

function deinterleave(src, dst, N) {
    for (let i = 0; i < N; i++) {
        dst[0][i] = src[2 * i + 0];
        dst[1][i] = src[2 * i + 1];
    }
}

//
// Helper to allocate an audio buffer in Module's address space,
// and access as either Float32Array or a pointer on the WASM heap.
//
class WASMBuffer {

    constructor(frames, channels) {
        this._frames = frames;
        this._channels = channels;

        const bytesPerChannel = this._frames * Float32Array.BYTES_PER_ELEMENT;
        this._dataPtr = Module._malloc(this._channels * bytesPerChannel);
        this._channelData = [];
        this._channelPtr = [];

        for (let i = 0; i < this._channels; i++) {
            let startPtr = this._dataPtr + i * bytesPerChannel;
            let endPtr = startPtr + bytesPerChannel;
            this._channelData[i] = Module.HEAPF32.subarray(startPtr / Float32Array.BYTES_PER_ELEMENT, endPtr / Float32Array.BYTES_PER_ELEMENT);
            this._channelPtr[i] = startPtr;
        }
    }

    // returns Float32Array representation of channel[index]
    getChannelData(index) {
        return index >= this._channels ? null : this._channelData[index];
    }

    // returns the pointer on the WASM heap to channel[index]
    getChannelPtr(index) {
        return index >= this._channels ? null : this._channelPtr[index];
    }
}

registerProcessor('wasm-license', class extends AudioWorkletProcessor {

    constructor() {
        super();

        const tokenErrorString = [
            "TOKEN_VALID",
            "TOKEN_INVALID_LENGTH",
            "TOKEN_INVALID_HEADER",
            "TOKEN_INVALID_VERSION",
            "TOKEN_INVALID_SIGNATURE",
            "TOKEN_CLOCK_ROLLBACK",
            "TOKEN_EXPIRED"
        ];

        this.port.onmessage = (e) => {
            let code = Module.activate(e.data);
            console.log('[wasm-license] activate token:', e.data);
            console.log('[wasm-license] activate returned:', tokenErrorString[code]);
        }
    }

    process(inputs, outputs) { return true; }
})

registerProcessor('wasm-hrtf-input', class extends AudioWorkletProcessor {

    static get parameterDescriptors() {
        return [
            { name: 'gain', defaultValue: 0, automationRate: 'k-rate' },
            { name: 'azimuth', defaultValue: 0, automationRate: 'k-rate' },
            { name: 'distance', defaultValue: 1, automationRate: 'k-rate' },
            { name: 'lpfdist', defaultValue: 16, automationRate: 'k-rate' },
        ];
    }

    constructor() {
        super();

        this._hrtf = new Module.HrtfInput();

        this._inputBuffer = new WASMBuffer(NUM_FRAMES, 1);  // mono
        this._outputBuffer = new WASMBuffer(NUM_FRAMES, 1); // interleaved stereo, 1/2 sample rate
    }

    process(inputs, outputs, parameters) {

        // copy in
        if (inputs[0].length == 0) {
            this._inputBuffer.getChannelData(0).fill(0);
        } else {
            this._inputBuffer.getChannelData(0).set(inputs[0][0]);
        }

        // process
        this._hrtf.setParameters(parameters.gain[0], parameters.azimuth[0], parameters.distance[0], parameters.lpfdist[0]);
        this._hrtf.process(this._inputBuffer.getChannelPtr(0), this._outputBuffer.getChannelPtr(0));

        // copy out
        outputs[0][0].set(this._outputBuffer.getChannelData(0));

        return true;
    }
})

registerProcessor('wasm-hrtf-output', class extends AudioWorkletProcessor {

    constructor() {
        super();

        this._interpolate2 = [ new Module.Interpolate2(), new Module.Interpolate2() ];

        this._inputBuffer = new WASMBuffer(NUM_FRAMES / 2, 2);  // stereo, 1/2 sample rate
        this._outputBuffer = new WASMBuffer(NUM_FRAMES, 2);     // stereo
    }

    process(inputs, outputs) {

        // deinterleave in
        if (inputs[0].length == 0) {
            this._inputBuffer.getChannelData(0).fill(0);
            this._inputBuffer.getChannelData(1).fill(0);
        } else {
            deinterleave(inputs[0][0], this._inputBuffer._channelData, NUM_FRAMES / 2);
        }

        // process
        this._interpolate2[0].process(this._inputBuffer.getChannelPtr(0), this._outputBuffer.getChannelPtr(0), NUM_FRAMES / 2);
        this._interpolate2[1].process(this._inputBuffer.getChannelPtr(1), this._outputBuffer.getChannelPtr(1), NUM_FRAMES / 2);

        // copy out
        outputs[0][0].set(this._outputBuffer.getChannelData(0));
        outputs[0][1].set(this._outputBuffer.getChannelData(1));

        return true;
    }
})

registerProcessor('wasm-limiter', class extends AudioWorkletProcessor {

    constructor() {
        super();

        this._limiter = new Module.Limiter(sampleRate);

        this._inoutBuffer = new WASMBuffer(2 * NUM_FRAMES, 1);  // interleaved stereo
    }

    process(inputs, outputs) {

        // interleave in
        if (inputs[0].length == 0) {
            this._inoutBuffer.getChannelData(0).fill(0);
        } else {
            interleave(inputs[0], this._inoutBuffer.getChannelData(0), NUM_FRAMES);
        }

        // process (in-place)
        this._limiter.process(this._inoutBuffer.getChannelPtr(0), this._inoutBuffer.getChannelPtr(0), NUM_FRAMES);

        // deinterleave out
        deinterleave(this._inoutBuffer.getChannelData(0), outputs[0], NUM_FRAMES);

        return true;
    }
})

registerProcessor('wasm-noise-gate', class extends AudioWorkletProcessor {

    static get parameterDescriptors() {
        return [
            { name: 'threshold', defaultValue: -40, automationRate: 'k-rate' },
        ];
    }

    constructor() {
        super();

        this._noiseGate = new Module.NoiseGate(sampleRate);

        this._inoutBuffer = new WASMBuffer(NUM_FRAMES, 1);  // mono
    }

    process(inputs, outputs, parameters) {

        // copy in
        if (inputs[0].length == 0) {
            this._inoutBuffer.getChannelData(0).fill(0);
        } else {
            this._inoutBuffer.getChannelData(0).set(inputs[0][0]);
        }

        // process (in-place)
        this._noiseGate.setThreshold(parameters.threshold[0]);
        this._noiseGate.process(this._inoutBuffer.getChannelPtr(0), this._inoutBuffer.getChannelPtr(0), NUM_FRAMES);

        // copy out
        outputs[0][0].set(this._inoutBuffer.getChannelData(0));

        return true;
    }
})