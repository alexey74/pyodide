import { Endpoint, EventSource, PostMessageWithOrigin, StoreKey } from "./protocol";
import { TransferHandler } from "./transfer_handlers";
export declare const createEndpoint: unique symbol;
export declare const releaseProxy: unique symbol;
/**
 * Takes a type and wraps it in a Promise, if it not already is one.
 * This is to avoid `Promise<Promise<T>>`.
 *
 * This is the inverse of `Unpromisify<T>`.
 */
declare type Promisify<T> = T extends Promise<unknown> ? T : Promise<T>;
/**
 * Takes a type that may be Promise and unwraps the Promise type.
 * If `P` is not a Promise, it returns `P`.
 *
 * This is the inverse of `Promisify<T>`.
 */
declare type Unpromisify<P> = P extends Promise<infer T> ? T : P;
/**
 * Takes the raw type of a remote property and returns the type that is visible to the local thread on the proxy.
 *
 * Note: This needs to be its own type alias, otherwise it will not distribute over unions.
 * See https://www.typescriptlang.org/docs/handbook/advanced-types.html#distributive-conditional-types
 */
declare type RemoteProperty<T> = T extends Function | ProxyMarked ? Remote<T> : Promisify<T>;
/**
 * Takes the raw type of a property as a remote thread would see it through a proxy (e.g. when passed in as a function
 * argument) and returns the type that the local thread has to supply.
 *
 * This is the inverse of `RemoteProperty<T>`.
 *
 * Note: This needs to be its own type alias, otherwise it will not distribute over unions. See
 * https://www.typescriptlang.org/docs/handbook/advanced-types.html#distributive-conditional-types
 */
declare type LocalProperty<T> = T extends Function | ProxyMarked ? Local<T> : Unpromisify<T>;
/**
 * Proxies `T` if it is a `ProxyMarked`, clones it otherwise (as handled by structured cloning and transfer handlers).
 */
export declare type ProxyOrClone<T> = T extends ProxyMarked ? Remote<T> : T;
/**
 * Inverse of `ProxyOrClone<T>`.
 */
export declare type UnproxyOrClone<T> = T extends RemoteObject<ProxyMarked> ? Local<T> : T;
/**
 * Takes the raw type of a remote object in the other thread and returns the type as it is visible to the local thread
 * when proxied with `Comlink.proxy()`.
 *
 * This does not handle call signatures, which is handled by the more general `Remote<T>` type.
 *
 * @template T The raw type of a remote object as seen in the other thread.
 */
export declare type RemoteObject<T> = {
    [P in keyof T]: RemoteProperty<T[P]>;
};
/**
 * Takes the type of an object as a remote thread would see it through a proxy (e.g. when passed in as a function
 * argument) and returns the type that the local thread has to supply.
 *
 * This does not handle call signatures, which is handled by the more general `Local<T>` type.
 *
 * This is the inverse of `RemoteObject<T>`.
 *
 * @template T The type of a proxied object.
 */
export declare type LocalObject<T> = {
    [P in keyof T]: LocalProperty<T[P]>;
};
/**
 * Additional special comlink methods available on each proxy returned by `Comlink.wrap()`.
 */
export interface ProxyMethods {
    [createEndpoint]: () => Promise<MessagePort>;
    [releaseProxy]: () => void;
}
/**
 * Takes the raw type of a remote object, function or class in the other thread and returns the type as it is visible to
 * the local thread from the proxy return value of `Comlink.wrap()` or `Comlink.proxy()`.
 */
export declare type Remote<T> = RemoteObject<T> & (T extends (...args: infer TArguments) => infer TReturn ? (...args: {
    [I in keyof TArguments]: UnproxyOrClone<TArguments[I]>;
}) => Promisify<ProxyOrClone<Unpromisify<TReturn>>> : unknown) & (T extends {
    new (...args: infer TArguments): infer TInstance;
} ? {
    new (...args: {
        [I in keyof TArguments]: UnproxyOrClone<TArguments[I]>;
    }): Promisify<Remote<TInstance>>;
} : unknown) & ProxyMethods;
/**
 * Expresses that a type can be either a sync or async.
 */
declare type MaybePromise<T> = Promise<T> | T;
/**
 * Takes the raw type of a remote object, function or class as a remote thread would see it through a proxy (e.g. when
 * passed in as a function argument) and returns the type the local thread has to supply.
 *
 * This is the inverse of `Remote<T>`. It takes a `Remote<T>` and returns its original input `T`.
 */
export declare type Local<T> = Omit<LocalObject<T>, keyof ProxyMethods> & (T extends (...args: infer TArguments) => infer TReturn ? (...args: {
    [I in keyof TArguments]: ProxyOrClone<TArguments[I]>;
}) => MaybePromise<UnproxyOrClone<Unpromisify<TReturn>>> : unknown) & (T extends {
    new (...args: infer TArguments): infer TInstance;
} ? {
    new (...args: {
        [I in keyof TArguments]: ProxyOrClone<TArguments[I]>;
    }): MaybePromise<Local<Unpromisify<TInstance>>>;
} : unknown);
export declare function expose(obj_arg: any, ep?: Endpoint): void;
export declare function wrap<T>(ep: Endpoint, target?: any): Remote<T>;
export declare function createProxy<T>(ep: Endpoint, store_key?: StoreKey, path?: (string | number | symbol)[], target?: object, keys?: never[]): Remote<T>;
export declare function windowEndpoint(w: PostMessageWithOrigin, context?: EventSource, targetOrigin?: string): Endpoint;
export declare const proxyMarker: unique symbol;
/**
 * Interface of values that were marked to be proxied with `comlink.proxy()`.
 * Can also be implemented by classes.
 */
export interface ProxyMarked {
    [proxyMarker]: true;
}
export declare function proxy<T>(obj: T): T & ProxyMarked;
/**
 * Internal transfer handle to handle objects marked to proxy.
 */
export declare const proxyTransferHandler: TransferHandler<object, MessagePort>;
export {};
