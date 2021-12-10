var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { requestResponseMessage, requestResponseMessageInner, UUID_LENGTH, } from "./request_response";
import { fromWireValue } from "./transfer_handlers";
let decoder = new TextDecoder("utf-8");
let encoder = new TextEncoder();
const SZ_BUF_SIZE_IDX = 0;
const SZ_BUF_FITS_IDX = 1;
const SZ_BUF_DOESNT_FIT = 0;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * This is a "syncifiable" promise. It consists of a task to be dispatched on
 * another thread. It can be dispatched asynchronously (the easy way) or
 * synchronously (the harder way). Either way, this promise does not start out
 * as scheduled, you
 */
export class ComlinkTask {
    constructor(endpoint, msg, transfers = [], extra = () => { }) {
        this.endpoint = endpoint;
        this.msg = msg;
        this.extra = extra;
        this.transfers = transfers;
        this._promise = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
    }
    schedule_async() {
        if (this.mode === "async") {
            // already scheduled
            return;
        }
        if (this.mode === "sync") {
            throw new Error("Already synchronously scheduled");
        }
        this.mode = "async";
        this.do_async().then((value) => {
            this._result = value;
            this._resolve(value);
        }, (reason) => {
            this._exception = reason;
            this._reject(reason);
        });
        return this;
    }
    then(onfulfilled, onrejected) {
        return __awaiter(this, void 0, void 0, function* () {
            this.schedule_async();
            return this._promise.then(onfulfilled, onrejected);
        });
    }
    catch(onrejected) {
        this.schedule_async();
        return this._promise.catch(onrejected);
    }
    finally(onfinally) {
        this.schedule_async();
        return this._promise.finally(onfinally);
    }
    schedule_sync() {
        if (this.mode === "sync") {
            // already scheduled
            return;
        }
        if (this.mode === "async") {
            throw new Error("Already asynchronously scheduled");
        }
        this.mode = "sync";
        Syncifier.scheduleTask(this);
        this._sync_gen = this.do_sync();
        this._sync_gen.next();
        return this;
    }
    poll() {
        if (this.mode != "sync") {
            throw new Error("Task not synchronously scheduled");
        }
        let { done, value } = this._sync_gen.next();
        if (!done) {
            return false;
        }
        try {
            this._result = fromWireValue(this.endpoint, value);
        }
        catch (e) {
            this._exception = e;
        }
        return true;
    }
    *do_sync() {
        // just use syncRequest.
        let { endpoint, msg, transfers } = this;
        let size_buffer = new Int32Array(new SharedArrayBuffer(8));
        let signal_buffer = this.signal_buffer;
        let taskId = this.taskId;
        // Ensure status is cleared. We will notify
        let data_buffer = acquireDataBuffer(UUID_LENGTH);
        console.debug("===requesting", taskId);
        endpoint.postMessage(Object.assign(Object.assign({}, msg), { size_buffer, data_buffer, signal_buffer, taskId, syncify: true }), transfers);
        yield;
        if (Atomics.load(size_buffer, SZ_BUF_FITS_IDX) === SZ_BUF_DOESNT_FIT) {
            // There wasn't enough space, make a bigger data_buffer.
            // First read uuid for response out of current data_buffer
            const id = decoder.decode(data_buffer.slice(0, UUID_LENGTH));
            releaseDataBuffer(data_buffer);
            const size = Atomics.load(size_buffer, SZ_BUF_SIZE_IDX);
            data_buffer = acquireDataBuffer(size);
            console.debug("===bigger data buffer", taskId);
            endpoint.postMessage({ id, data_buffer });
            yield;
        }
        const size = Atomics.load(size_buffer, SZ_BUF_SIZE_IDX);
        console.debug("===completing", taskId);
        return JSON.parse(decoder.decode(data_buffer.slice(0, size)));
    }
    do_async() {
        return __awaiter(this, void 0, void 0, function* () {
            let result = yield requestResponseMessage(this.endpoint, this.msg, this.transfers);
            this.extra();
            return fromWireValue(this.endpoint, result);
        });
    }
    get result() {
        if (this._result) {
            return this._result;
        }
        else if (this._exception) {
            throw this._exception;
        }
        else {
            throw new Error("Not ready.");
        }
    }
    syncify() {
        this.schedule_sync();
        Syncifier.syncifyTask(this);
        return this.result;
    }
}
function signalRequester(signal_buffer, taskId) {
    return __awaiter(this, void 0, void 0, function* () {
        let index = (taskId >> 1) % 32;
        let sleepTime = 1;
        while (Atomics.compareExchange(signal_buffer, index + 1, 0, taskId) !== 0) {
            // No Atomics.asyncWait except on Chrome =(
            yield sleep(sleepTime);
            if (sleepTime < 32) {
                // exponential backoff
                sleepTime *= 2;
            }
        }
        Atomics.or(signal_buffer, 0, 1 << index);
        // @ts-ignore
        Atomics.notify(signal_buffer, 0);
    });
}
/**
 * Respond to a blocking request. Most of the work has already been done in
 * asynclink, we are just responsible here for getting the return value back to
 * the requester through this slightly convoluted Atomics protocol.
 *
 * @param endpoint A message port to receive messages from. Other thread is
 *        blocked, so we can't send messages back.
 * @param msg The message that was recieved. We will use it to read out the
 *        buffers to write the answer into. NOTE: requester owns buffers.
 * @param returnValue The value we want to send back to the requester. We have
 *        to encode it into data_buffer.
 */
export function syncResponse(endpoint, msg, returnValue) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            let { size_buffer, data_buffer, signal_buffer, taskId } = msg;
            console.debug('== msg:', msg);
            let bytes = encoder.encode(JSON.stringify(returnValue));
            let fits = bytes.length <= data_buffer.length;
            Atomics.store(size_buffer, SZ_BUF_SIZE_IDX, bytes.length);
            Atomics.store(size_buffer, SZ_BUF_FITS_IDX, +fits);
            if (!fits) {
                console.debug("      need larger buffer", taskId);
                // Request larger buffer
                let [uuid, data_promise] = requestResponseMessageInner(endpoint);
                // Write UUID into data_buffer so syncRequest knows where to respond to.
                data_buffer.set(encoder.encode(uuid));
                yield signalRequester(signal_buffer, taskId);
                // Wait for response with new bigger data_buffer
                data_buffer = (yield data_promise).data_buffer;
            }
            // Encode result into data_buffer
            data_buffer.set(bytes);
            Atomics.store(size_buffer, SZ_BUF_FITS_IDX, +true);
            // @ts-ignore
            console.debug("       signaling completion", taskId);
            yield signalRequester(signal_buffer, taskId);
        }
        catch (e) {
            console.warn(e);
        }
    });
}
let dataBuffers = [];
function acquireDataBuffer(size) {
    let powerof2 = Math.ceil(Math.log2(size));
    if (!dataBuffers[powerof2]) {
        dataBuffers[powerof2] = [];
    }
    let result = dataBuffers[powerof2].pop();
    if (result) {
        result.fill(0);
        return result;
    }
    return new Uint8Array(new SharedArrayBuffer(Math.pow(2, powerof2)));
}
function releaseDataBuffer(buffer) {
    let powerof2 = Math.ceil(Math.log2(buffer.byteLength));
    dataBuffers[powerof2].push(buffer);
}
/**
 * Another thread can set this to a nonzero value to request an interrupt.
 */
export let interrupt_buffer = new Int32Array(new SharedArrayBuffer(4));
let handleInterrupt = () => {
    interrupt_buffer[0] = 0;
    throw new Error("Interrupted!");
};
/**
 * Sets the interrupt handler. This is called when the computation is
 * interrupted. Should zero the interrupt buffer and throw an exception.
 * @param handler
 */
export function setInterruptHandler(handler) {
    handleInterrupt = handler;
}
class _Syncifier {
    constructor() {
        this.nextTaskId = new Int32Array([1]);
        this.signal_buffer = new Int32Array(new SharedArrayBuffer(32 * 4 + 4));
        this.tasks = new Map();
    }
    scheduleTask(task) {
        task.taskId = this.nextTaskId[0];
        this.nextTaskId[0] += 2;
        task.signal_buffer = this.signal_buffer;
        this.tasks.set(task.taskId, task);
    }
    waitOnSignalBuffer() {
        let timeout = 50;
        while (true) {
            let status = Atomics.wait(this.signal_buffer, 0, 0, timeout);
            switch (status) {
                case "ok":
                case "not-equal":
                    return;
                case "timed-out":
                    if (interrupt_buffer[0] !== 0) {
                        handleInterrupt();
                    }
                    break;
                default:
                    throw new Error("Unreachable");
            }
        }
    }
    *tasksIdsToWakeup() {
        let flag = Atomics.load(this.signal_buffer, 0);
        for (let i = 0; i < 32; i++) {
            let bit = 1 << i;
            if (flag & bit) {
                Atomics.and(this.signal_buffer, 0, ~bit);
                let wokenTask = Atomics.exchange(this.signal_buffer, i + 1, 0);
                yield wokenTask;
            }
        }
    }
    pollTasks(task) {
        let result = false;
        for (let wokenTaskId of this.tasksIdsToWakeup()) {
            let wokenTask = this.tasks.get(wokenTaskId);
            if (!wokenTask) {
                throw new Error(`Assertion error: unknown taskId ${wokenTaskId}.`);
            }
            if (wokenTask.poll()) {
                console.debug("completed task ", wokenTaskId, wokenTask); //, wokenTask._result);
                this.tasks.delete(wokenTaskId);
                if (wokenTask === task) {
                    result = true;
                }
            }
        }
        return result;
    }
    syncifyTask(task) {
        while (true) {
            this.waitOnSignalBuffer();
            if (this.pollTasks(task)) {
                return;
            }
        }
    }
}
export let Syncifier = new _Syncifier();
(function syncifyPollLoop() {
    return __awaiter(this, void 0, void 0, function* () {
        while (true) {
            Syncifier.pollTasks();
            yield sleep(20);
        }
    });
})();
