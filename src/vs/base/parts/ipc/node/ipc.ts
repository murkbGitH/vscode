/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { TPromise } from 'vs/base/common/winjs.base';
import { IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { Event, Emitter, once, filterEvent, toPromise, Relay } from 'vs/base/common/event';
import { always } from 'vs/base/common/async';

export enum RequestType {
	Promise = 100,
	PromiseCancel = 101,
	EventListen = 102,
	EventDispose = 103
}

type IRawPromiseRequest = { type: RequestType.Promise; id: number; channelName: string; name: string; arg: any; };
type IRawPromiseCancelRequest = { type: RequestType.PromiseCancel, id: number };
type IRawEventListenRequest = { type: RequestType.EventListen; id: number; channelName: string; name: string; arg: any; };
type IRawEventDisposeRequest = { type: RequestType.EventDispose, id: number };
type IRawRequest = IRawPromiseRequest | IRawPromiseCancelRequest | IRawEventListenRequest | IRawEventDisposeRequest;

export enum ResponseType {
	Initialize = 200,
	PromiseSuccess = 201,
	PromiseError = 202,
	PromiseErrorObj = 203,
	EventFire = 204
}

type IRawInitializeResponse = { type: ResponseType.Initialize };
type IRawPromiseSuccessResponse = { type: ResponseType.PromiseSuccess; id: number; data: any };
type IRawPromiseErrorResponse = { type: ResponseType.PromiseError; id: number; data: { message: string, name: string, stack: string[] | undefined } };
type IRawPromiseErrorObjResponse = { type: ResponseType.PromiseErrorObj; id: number; data: any };
type IRawEventFireResponse = { type: ResponseType.EventFire; id: number; data: any };
type IRawResponse = IRawInitializeResponse | IRawPromiseSuccessResponse | IRawPromiseErrorResponse | IRawPromiseErrorObjResponse | IRawEventFireResponse;

interface IHandler {
	(response: IRawResponse): void;
}

export interface IMessagePassingProtocol {
	send(buffer: Buffer): void;
	onMessage: Event<Buffer>;
}

enum State {
	Uninitialized,
	Idle
}

/**
 * An `IChannel` is an abstraction over a collection of commands.
 * You can `call` several commands on a channel, each taking at
 * most one single argument. A `call` always returns a promise
 * with at most one single return value.
 */
export interface IChannel {
	call<T>(command: string, arg?: any): TPromise<T>;
	listen<T>(event: string, arg?: any): Event<T>;
}

/**
 * An `IChannelServer` hosts a collection of channels. You are
 * able to register channels onto it, provided a channel name.
 */
export interface IChannelServer {
	registerChannel(channelName: string, channel: IChannel): void;
}

/**
 * An `IChannelClient` has access to a collection of channels. You
 * are able to get those channels, given their channel name.
 */
export interface IChannelClient {
	getChannel<T extends IChannel>(channelName: string): T;
}

/**
 * An `IClientRouter` is responsible for routing calls to specific
 * channels, in scenarios in which there are multiple possible
 * channels (each from a separate client) to pick from.
 */
export interface IClientRouter {
	routeCall(command: string, arg: any): TPromise<string>;
	routeEvent(event: string, arg: any): TPromise<string>;
}

/**
 * Similar to the `IChannelClient`, you can get channels from this
 * collection of channels. The difference being that in the
 * `IRoutingChannelClient`, there are multiple clients providing
 * the same channel. You'll need to pass in an `IClientRouter` in
 * order to pick the right one.
 */
export interface IRoutingChannelClient {
	getChannel<T extends IChannel>(channelName: string, router: IClientRouter): T;
}

enum BodyType {
	Undefined,
	String,
	Buffer,
	Object
}

const empty = Buffer.allocUnsafe(0);

function serializeBody(body: any): { buffer: Buffer, type: BodyType } {
	if (typeof body === 'undefined') {
		return { buffer: empty, type: BodyType.Undefined };
	} else if (typeof body === 'string') {
		return { buffer: Buffer.from(body), type: BodyType.String };
	} else if (Buffer.isBuffer(body)) {
		return { buffer: body, type: BodyType.Buffer };
	} else {
		return { buffer: Buffer.from(JSON.stringify(body)), type: BodyType.Object };
	}
}

function serialize(header: any, body: any = undefined): Buffer {
	const headerSizeBuffer = Buffer.allocUnsafe(4);
	const { buffer: bodyBuffer, type: bodyType } = serializeBody(body);
	const headerBuffer = Buffer.from(JSON.stringify([header, bodyType]));
	headerSizeBuffer.writeUInt32BE(headerBuffer.byteLength, 0);

	return Buffer.concat([headerSizeBuffer, headerBuffer, bodyBuffer]);
}

function deserializeBody(bodyBuffer: Buffer, bodyType: BodyType): any {
	switch (bodyType) {
		case BodyType.Undefined: return undefined;
		case BodyType.String: return bodyBuffer.toString();
		case BodyType.Buffer: return bodyBuffer;
		case BodyType.Object: return JSON.parse(bodyBuffer.toString());
	}
}

function deserialize(buffer: Buffer): { header: any, body: any } {
	const headerSize = buffer.readUInt32BE(0);
	const headerBuffer = buffer.slice(4, 4 + headerSize);
	const bodyBuffer = buffer.slice(4 + headerSize);
	const [header, bodyType] = JSON.parse(headerBuffer.toString());
	const body = deserializeBody(bodyBuffer, bodyType);

	return { header, body };
}

export class ChannelServer implements IChannelServer, IDisposable {

	private channels = new Map<string, IChannel>();
	private activeRequests = new Map<number, IDisposable>();
	private protocolListener: IDisposable;

	constructor(private protocol: IMessagePassingProtocol) {
		this.protocolListener = this.protocol.onMessage(msg => this.onRawMessage(msg));
		this.sendResponse({ type: ResponseType.Initialize });
	}

	registerChannel(channelName: string, channel: IChannel): void {
		this.channels.set(channelName, channel);
	}

	private sendResponse(response: IRawResponse): void {
		switch (response.type) {
			case ResponseType.Initialize:
				return this.sendBuffer(serialize([response.type]));

			case ResponseType.PromiseSuccess:
			case ResponseType.PromiseError:
			case ResponseType.EventFire:
			case ResponseType.PromiseErrorObj:
				return this.sendBuffer(serialize([response.type, response.id], response.data));
		}
	}

	private sendBuffer(message: Buffer): void {
		try {
			this.protocol.send(message);
		} catch (err) {
			// noop
		}
	}

	private onRawMessage(message: Buffer): void {
		const { header, body } = deserialize(message);
		const type = header[0] as RequestType;

		switch (type) {
			case RequestType.Promise:
				return this.onPromise({ type, id: header[1], channelName: header[2], name: header[3], arg: body });
			case RequestType.EventListen:
				return this.onEventListen({ type, id: header[1], channelName: header[2], name: header[3], arg: body });
			case RequestType.PromiseCancel:
				return this.disposeActiveRequest({ type, id: header[1] });
			case RequestType.EventDispose:
				return this.disposeActiveRequest({ type, id: header[1] });
		}
	}

	private onPromise(request: IRawPromiseRequest): void {
		const channel = this.channels.get(request.channelName);
		let promise: TPromise<any>;

		try {
			promise = channel.call(request.name, request.arg);
		} catch (err) {
			promise = TPromise.wrapError(err);
		}

		const id = request.id;

		const requestPromise = promise.then(data => {
			this.sendResponse(<IRawResponse>{ id, data, type: ResponseType.PromiseSuccess });
			this.activeRequests.delete(request.id);
		}, data => {
			if (data instanceof Error) {
				this.sendResponse(<IRawResponse>{
					id, data: {
						message: data.message,
						name: data.name,
						stack: data.stack ? (data.stack.split ? data.stack.split('\n') : data.stack) : void 0
					}, type: ResponseType.PromiseError
				});
			} else {
				this.sendResponse(<IRawResponse>{ id, data, type: ResponseType.PromiseErrorObj });
			}

			this.activeRequests.delete(request.id);
		});

		this.activeRequests.set(request.id, toDisposable(() => requestPromise.cancel()));
	}

	private onEventListen(request: IRawEventListenRequest): void {
		const channel = this.channels.get(request.channelName);

		const id = request.id;
		const event = channel.listen(request.name, request.arg);
		const disposable = event(data => this.sendResponse(<IRawResponse>{ id, data, type: ResponseType.EventFire }));

		this.activeRequests.set(request.id, disposable);
	}

	private disposeActiveRequest(request: IRawRequest): void {
		const disposable = this.activeRequests.get(request.id);

		if (disposable) {
			disposable.dispose();
			this.activeRequests.delete(request.id);
		}
	}

	public dispose(): void {
		this.protocolListener.dispose();
		this.protocolListener = null;
		this.activeRequests.forEach(d => d.dispose());
		this.activeRequests.clear();
	}
}

export class ChannelClient implements IChannelClient, IDisposable {

	private state: State = State.Uninitialized;
	private activeRequests = new Set<IDisposable>();
	private handlers = new Map<number, IHandler>();
	private lastRequestId: number = 0;
	private protocolListener: IDisposable;

	private _onDidInitialize = new Emitter<void>();
	readonly onDidInitialize = this._onDidInitialize.event;

	constructor(private protocol: IMessagePassingProtocol) {
		this.protocolListener = this.protocol.onMessage(msg => this.onBuffer(msg));
	}

	getChannel<T extends IChannel>(channelName: string): T {
		const call = (command: string, arg: any) => this.requestPromise(channelName, command, arg);
		const listen = (event: string, arg: any) => this.requestEvent(channelName, event, arg);

		return { call, listen } as T;
	}

	private requestPromise(channelName: string, name: string, arg: any): TPromise<any> {
		const id = this.lastRequestId++;
		const type = RequestType.Promise;
		const request: IRawRequest = { id, type, channelName, name, arg };

		const activeRequest = this.whenInitialized().then(() => {
			const id = request.id;

			return new TPromise((c, e) => {
				const handler: IHandler = response => {
					switch (response.type) {
						case ResponseType.PromiseSuccess:
							delete this.handlers[id];
							c(response.data);
							break;

						case ResponseType.PromiseError:
							delete this.handlers[id];
							const error = new Error(response.data.message);
							(<any>error).stack = response.data.stack;
							error.name = response.data.name;
							e(error);
							break;

						case ResponseType.PromiseErrorObj:
							delete this.handlers[id];
							e(response.data);
							break;
					}
				};

				this.handlers.set(id, handler);
				this.sendRequest(request);
			}, () => this.sendRequest({ id, type: RequestType.PromiseCancel }));
		});

		const disposable = toDisposable(() => activeRequest.cancel());
		this.activeRequests.add(disposable);
		always(activeRequest, () => this.activeRequests.delete(disposable));

		return activeRequest;
	}

	private requestEvent(channelName: string, name: string, arg: any): Event<any> {
		const id = this.lastRequestId++;
		const type = RequestType.EventListen;
		const request: IRawRequest = { id, type, channelName, name, arg };

		let uninitializedPromise: TPromise<any> | null = null;

		const emitter = new Emitter<any>({
			onFirstListenerAdd: () => {
				uninitializedPromise = this.whenInitialized();
				uninitializedPromise.then(() => {
					uninitializedPromise = null;
					this.activeRequests.add(emitter);
					this.sendRequest(request);
				});
			},
			onLastListenerRemove: () => {
				if (uninitializedPromise) {
					uninitializedPromise.cancel();
					uninitializedPromise = null;
				} else {
					this.activeRequests.delete(emitter);
					this.sendRequest({ id, type: RequestType.EventDispose });
				}
			}
		});

		const handler: IHandler = (res: IRawEventFireResponse) => emitter.fire(res.data);
		this.handlers.set(id, handler);

		return emitter.event;
	}

	private sendRequest(request: IRawRequest): void {
		switch (request.type) {
			case RequestType.Promise:
			case RequestType.EventListen:
				return this.sendBuffer(serialize([request.type, request.id, request.channelName, request.name], request.arg));

			case RequestType.PromiseCancel:
			case RequestType.EventDispose:
				return this.sendBuffer(serialize([request.type, request.id]));
		}
	}

	private sendBuffer(message: Buffer): void {
		try {
			this.protocol.send(message);
		} catch (err) {
			// noop
		}
	}

	private onBuffer(message: Buffer): void {
		const { header, body } = deserialize(message);
		const type: ResponseType = header[0];

		switch (type) {
			case ResponseType.Initialize:
				return this.onResponse({ type: header[0] });

			case ResponseType.PromiseSuccess:
			case ResponseType.PromiseError:
			case ResponseType.EventFire:
			case ResponseType.PromiseErrorObj:
				return this.onResponse({ type: header[0], id: header[1], data: body });
		}
	}

	private onResponse(response: IRawResponse): void {
		if (response.type === ResponseType.Initialize) {
			this.state = State.Idle;
			this._onDidInitialize.fire();
			return;
		}

		const handler = this.handlers.get(response.id);

		if (handler) {
			handler(response);
		}
	}

	private whenInitialized(): TPromise<void> {
		if (this.state === State.Idle) {
			return TPromise.as(null);
		} else {
			return TPromise.wrap(toPromise(this.onDidInitialize));
		}
	}

	dispose(): void {
		this.protocolListener.dispose();
		this.protocolListener = null;
		this.activeRequests.forEach(p => p.dispose());
		this.activeRequests.clear();
	}
}

export interface ClientConnectionEvent {
	protocol: IMessagePassingProtocol;
	onDidClientDisconnect: Event<void>;
}

/**
 * An `IPCServer` is both a channel server and a routing channel
 * client.
 *
 * As the owner of a protocol, you should extend both this
 * and the `IPCClient` classes to get IPC implementations
 * for your protocol.
 */
export class IPCServer implements IChannelServer, IRoutingChannelClient, IDisposable {

	private channels = new Map<string, IChannel>();
	private channelClients = new Map<string, ChannelClient>();
	private onClientAdded = new Emitter<string>();

	constructor(onDidClientConnect: Event<ClientConnectionEvent>) {
		onDidClientConnect(({ protocol, onDidClientDisconnect }) => {
			const onFirstMessage = once(protocol.onMessage);

			onFirstMessage(rawId => {
				const channelServer = new ChannelServer(protocol);
				const channelClient = new ChannelClient(protocol);

				this.channels.forEach((channel, name) => channelServer.registerChannel(name, channel));

				const id = rawId.toString();
				this.channelClients.set(id, channelClient);
				this.onClientAdded.fire(id);

				onDidClientDisconnect(() => {
					channelServer.dispose();
					channelClient.dispose();
					this.channelClients.delete(id);
				});
			});
		});
	}

	getChannel<T extends IChannel>(channelName: string, router: IClientRouter): T {
		const call = (command: string, arg: any) => {
			const channelPromise = router.routeCall(command, arg)
				.then(id => this.getClient(id))
				.then(client => client.getChannel(channelName));

			return getDelayedChannel(channelPromise)
				.call(command, arg);
		};

		const listen = (event: string, arg: any) => {
			const channelPromise = router.routeEvent(event, arg)
				.then(id => this.getClient(id))
				.then(client => client.getChannel(channelName));

			return getDelayedChannel(channelPromise)
				.listen(event, arg);
		};

		return { call, listen } as T;
	}

	registerChannel(channelName: string, channel: IChannel): void {
		this.channels.set(channelName, channel);
	}

	private getClient(clientId: string): TPromise<IChannelClient> {
		if (!clientId) {
			return TPromise.wrapError(new Error('Client id should be provided'));
		}

		const client = this.channelClients.get(clientId);

		if (client) {
			return TPromise.as(client);
		}

		return new TPromise<IChannelClient>(c => {
			const onClient = once(filterEvent(this.onClientAdded.event, id => id === clientId));
			onClient(() => c(this.channelClients.get(clientId)));
		});
	}

	dispose(): void {
		this.channels.clear();
		this.channelClients.clear();
		this.onClientAdded.dispose();
	}
}

/**
 * An `IPCClient` is both a channel client and a channel server.
 *
 * As the owner of a protocol, you should extend both this
 * and the `IPCClient` classes to get IPC implementations
 * for your protocol.
 */
export class IPCClient implements IChannelClient, IChannelServer, IDisposable {

	private channelClient: ChannelClient;
	private channelServer: ChannelServer;

	constructor(protocol: IMessagePassingProtocol, id: string) {
		protocol.send(Buffer.from(id));
		this.channelClient = new ChannelClient(protocol);
		this.channelServer = new ChannelServer(protocol);
	}

	getChannel<T extends IChannel>(channelName: string): T {
		return this.channelClient.getChannel(channelName) as T;
	}

	registerChannel(channelName: string, channel: IChannel): void {
		this.channelServer.registerChannel(channelName, channel);
	}

	dispose(): void {
		this.channelClient.dispose();
		this.channelClient = null;
		this.channelServer.dispose();
		this.channelServer = null;
	}
}

export function getDelayedChannel<T extends IChannel>(promise: TPromise<T>): T {
	const call = (command: string, arg: any) => promise.then(c => c.call(command, arg));
	const listen = (event: string, arg: any) => {
		const relay = new Relay<any>();
		promise.then(c => relay.input = c.listen(event, arg));
		return relay.event;
	};

	return { call, listen } as T;
}

export function getNextTickChannel<T extends IChannel>(channel: T): T {
	let didTick = false;

	const call = (command: string, arg: any) => {
		if (didTick) {
			return channel.call(command, arg);
		}

		return TPromise.timeout(0)
			.then(() => didTick = true)
			.then(() => channel.call(command, arg));
	};

	const listen = (event: string, arg: any): Event<any> => {
		if (didTick) {
			return channel.listen(event, arg);
		}

		const relay = new Relay();

		TPromise.timeout(0)
			.then(() => didTick = true)
			.then(() => relay.input = channel.listen(event, arg));

		return relay.event;
	};

	return { call, listen } as T;
}
