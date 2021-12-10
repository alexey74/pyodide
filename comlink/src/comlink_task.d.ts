import { Endpoint, Message, WireValue } from "./protocol";
/**
 * This is a "syncifiable" promise. It consists of a task to be dispatched on
 * another thread. It can be dispatched asynchronously (the easy way) or
 * synchronously (the harder way). Either way, this promise does not start out
 * as scheduled, you
 */
export declare class ComlinkTask {
    endpoint: Endpoint;
    msg: Message;
    extra: () => void;
    transfers: Transferable[];
    mode?: "sync" | "async";
    _result?: any;
    _exception?: any;
    _promise: Promise<any>;
    _resolve: (value: any) => void;
    _reject: (value: any) => void;
    taskId?: number;
    _sync_gen?: Generator<void, any, void>;
    size_buffer?: Int32Array;
    signal_buffer?: Int32Array;
    constructor(endpoint: Endpoint, msg: Message, transfers?: Transferable[], extra?: () => void);
    schedule_async(): this | undefined;
    then(onfulfilled: (value: any) => any, onrejected: (reason: any) => any): Promise<any>;
    catch(onrejected: (reason: any) => any): Promise<any>;
    finally(onfinally: () => void): Promise<any>;
    schedule_sync(): this | undefined;
    poll(): boolean;
    do_sync(): Generator<undefined, any, unknown>;
    do_async(): Promise<any>;
    get result(): any;
    syncify(): any;
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
export declare function syncResponse(endpoint: Endpoint, msg: any, returnValue: WireValue): Promise<void>;
/**
 * Another thread can set this to a nonzero value to request an interrupt.
 */
export declare let interrupt_buffer: Int32Array;
/**
 * Sets the interrupt handler. This is called when the computation is
 * interrupted. Should zero the interrupt buffer and throw an exception.
 * @param handler
 */
export declare function setInterruptHandler(handler: () => never): void;
declare class _Syncifier {
    nextTaskId: Int32Array;
    signal_buffer: Int32Array;
    tasks: Map<number, ComlinkTask>;
    constructor();
    scheduleTask(task: ComlinkTask): void;
    waitOnSignalBuffer(): void;
    tasksIdsToWakeup(): Generator<number, void, unknown>;
    pollTasks(task?: ComlinkTask): boolean;
    syncifyTask(task: ComlinkTask): void;
}
export declare let Syncifier: _Syncifier;
export {};
