function nope(){
}

function CommandDispatcher() {
	this.handlers = {};
	this.defaultHandler = function( command ){
		console.warn( "Unhandled command ", command );
	};
}

CommandDispatcher.prototype.register = function( name, handler ){ //TOOD: Should this be on/off paradigm instead?
	this.handlers[ name ] = handler;
}

CommandDispatcher.prototype.unregister = function( name ){
	delete this.handlers[name];
}

CommandDispatcher.prototype.dispatch = function( message, env ){
	var handlerName = message.command;
	var handler = (this.handlers[ handlerName ] || this.defaultHandler);
	handler( message, env );
}

CommandDispatcher.prototype.once = function( name, handler ){
	if( !name ) { throw new Error("name not defined"); }
	if( !handler ) { throw new Error("handler not defined"); }

	this.register( name, function( message, context ) {
		this.unregister( name );
		handler( message, context );
	}.bind(this) );
	return name;
}

//TODO: This method needs better test coverage
//TODO: This needs to be moved to the Promise Protocol
CommandDispatcher.prototype.promiseMessage = function( name ){
	if( !name ){ throw new Error( "command name must be defined" ); }

	var result;
	var closure;
	this.once( name, function( message, env ){
		if( message.transfered ){ throw new Error("Transfer list clobbered"); }
		if( env && env.ports && env.ports.length > 0 ){
			message.transfered = env.ports;
		}

		if( closure ){
			closure( message );
		}else{
			result = message;
		}
	});

	return new Promise( function( fulfill, reject ){
		if( result ){
			fulfill( result );
		}else{
			closure = fulfill;
		}
	});
}

CommandDispatcher.prototype.linkChannel = function( channel ){
	channel.addEventListener( 'message', function( event ){
		this.dispatch( event.data, event );
	}.bind(this));
}


function Base36Namer(){
	this.id = 0;
}

Base36Namer.prototype.next = function(){
	var me = this.id;
	this.id++;
	return me.toString(36);
}


function promise_protocol_repliesTo( name, handler ){
	if( !handler ){ throw new Error("handler required"); }
	var self = this;
	function promise_interceptor( message, env ){
		if( message.replyTo === undefined ){
			console.warn( "replyTo required on message ", message );
			return;
		}

		try {
			if( env ){
				if( message.transfered ){ throw new Error("Transfer list conflict"); }
				message.transfered = env.ports;
			}
			var progressNotices;
			var progressName = message.progressName;
			if( progressName ){
				progressNotices = function( message ){
					self.send({command: progressName, details: message });
				}.bind( this );
			}else{
				progressNotices = nope;
			}

			var handlerPromise = Promise.resolve( handler( message, progressNotices ) );
			handlerPromise.then( function( result ){
				//TODO: Test if result is undefined (transfer == [] if so) 
				var transfer = result.transfer ? result.transfer : [];
				delete result.transfer;
				self.send({ command: message.replyTo, success: true, result: result }, transfer );
			}, function( error ){
			/* TODO: Debuggin
				if( error.stack ){
					console.error("Promise to ", message.replyTo," failed: ", error.message , error.stack);
				}
				*/
				self.send({ command: message.replyTo, success: false, error: error.toString()});
			});
		}catch( problem ){
			/* TODO: Debuggin
			console.error("Failed to dispatch for message", problem, problem.stack);
			*/
			self.send({ command: message.replyTo, success: false, error: problem.toString()});
		}
	}

	this.register( name, promise_interceptor );
}

function promies_protocol_withProgressAndReplyTo( message ){
	var name = this.namer.next();
	message.progressName = name;

	var self = this;
	this.register( name , function( message ){
		var details = message.details;
		result.onProgress( details );
	});
	var result = this.withReplyTo( message );
	result.then( function(){ self.unregister( name ); }, function(){ self.unregister(); });
	result.onProgress = nope;
	return result;
}

function promise_protocol_withReplyTo( message ){
	if( message.replyTo ){ throw new Error("replyTo not allowed (used by the protocol)"); }
	var name = this.namer.next();
	var future = this.promiseMessage( name ).then( function( resolution ){//TODO: move promise message into this protocol
		if( resolution.success ){
			var output = resolution.result;
			if( resolution.transfered && resolution.transfered.length > 0 ){//TODO: determine cleaner method of dealing with transfers
				output.transfered = resolution.transfered;
			}
			return output;
		}else{
			if( !resolution.error ){
				throw new Error( "Command failed to properly respond for " + message.command);
			}else{
				throw new Error( resolution.error );
			}
		}
	});
	message.replyTo = name;
	var transfer = message.transfer ? message.transfer : [];
	delete message.transfer;
	this.send( message, transfer );
	return future;
}

CommandDispatcher.prototype.usesPromises = function( namer ) {//TODO: better method for appending interface in JS idioms?
	if( namer ){ this.namer = namer; }

	//Client stuff
	this.withReplyTo = promise_protocol_withReplyTo;
	this.withProgressAndReplyTo = promies_protocol_withProgressAndReplyTo;
	//Serivce stuff
	this.repliesTo = promise_protocol_repliesTo;
}

// TODO: Extract into own file
function port_linkage_send( message, transferables ) {
	//console.log( "Sending: ", message );
	this.port.postMessage( message, transferables );
}

CommandDispatcher.prototype.linkPort = function( port, hasStarted ){
	this.port = port;
	this.send = port_linkage_send;

	this.linkChannel( port );//TODO: Extract and place in this protocol
	if( !hasStarted ){
		this.port.start();
	}
}

CommandDispatcher.prototype.reportUnhandled = function( componentName ){
	this.defaultHandler = function( message ){
		console.warn( "[", componentName, "] Unhandled message: ", message);
	}
}


var supervisorProtocol = {
	initialize: 'giraffe:supervisor:initialize',
	initialized: 'giraffe:supervisor:initialized',

	batch: 'giraffe:supervisor:batch',
	result: 'giraffe:supervisor:result'
};

function supervisor_protocol_client( channel, dispatcher ){
	dispatcher = ( dispatcher || new CommandDispatcher());
	dispatcher.linkChannel( channel );
	dispatcher.register( supervisorProtocol.initialized, function(){
		control.initialized();
	});
	dispatcher.register( supervisorProtocol.result, function( command ){
		control.onResult( command.result ); 
	});

	function initialize(){
		channel.start();
		channel.postMessage({ command: supervisorProtocol.initialize });
	}

	function send_batch( batch ){
		channel.postMessage({ command: supervisorProtocol.batch, batch: batch });
	}

	var control = {
		initialize: initialize,
		batch: send_batch,

		initialized: nope,
		onResult: nope
	};

	return control;
}

function supervisor_protocol_service( channel, dispatcher ){
	dispatcher = (dispatcher || new CommandDispatcher());
	dispatcher.linkChannel( channel );

	dispatcher.register( supervisorProtocol.initialize, function(){
		var result = control.initialize();
		channel.postMessage({ command: supervisorProtocol.initialized });
	});

	dispatcher.register( supervisorProtocol.batch, function( command ){
		control.onBatch( command.batch );
	});

	function start(){
		channel.start();
	}

	function send_results( result ){
		channel.postMessage({ command: supervisorProtocol.result, result: result });
	}

	var control = {
		start: start,
		completed: send_results,

		initialize: nope,
		onBatch: nope
	};

	return control;
}


var workerFactoryProtocol = {
	spawn: 'giraffe:worker-factory:spawn',
};

function RemoteWorkerFactory( dispatcher ){
	this.dispatcher = dispatcher;
}
RemoteWorkerFactory.prototype.spawn = function( configuration ){
	return this.dispatcher.withReplyTo({ command: workerFactoryProtocol.spawn, config: configuration });
}

function worker_factory_client( dispatcher ){
	return new RemoteWorkerFactory( dispatcher );
}

function worker_factory_service( dispatcher, factory ){
	if( !factory ){ throw new Error("Factory requried"); }

	dispatcher.repliesTo( workerFactoryProtocol.spawn, function( command ){
		var config = command.config;
		var result = factory.spawn( config );
		var factoryPromise = Promise.resolve( result );
		return factoryPromise;
	});
}


function Giraffe( config ){
	this.cfg = config || {};
	this.cfg.worker = this.cfg.worker || {};
	this.cfg.worker.script = this.cfg.worker.script || "web-giraffe-worker.js";
	this.cfg.worker.maximum = navigator.hardwareConcurrency || 6;

	this.pendingPromises = [];
	this.dispatcher = new CommandDispatcher();
	this.dispatcher.usesPromises( new Base36Namer() );
	this.dispatcher.defaultHandler = function( command ){
		console.error( "Recieved invalid command: ", command )
	};

	/*
	 * WorkerFactory service
	 * TOOD: Needs to be converted to promise interface
	 */
	this.dispatcher.repliesTo(  workerFactoryProtocol.spawn, function( command ){
		return new Promise( function( fulfill, reject ){
			var channel = new MessageChannel();

			var workerScript = this.cfg.worker;
			var worker = new Worker( workerScript );
			worker.addEventListener( "error", function( problem ){
				console.error( "Problem setting up work agent", problem );
			});
			worker.postMessage({ command: "giraffe:browser-worker-init", id: command.id }, [channel.port2] );
			fulfill({ transfer: [channel.port1] });
		}.bind(this));
	}.bind( this ) );

	this.namer = new Base36Namer();
}

Giraffe.prototype.start = function(){
	if( this.supervisor ) { return; }

	var supervisorScript = this.cfg.supervisor || "web-giraffe-supervisor.js";
	this.supervisor = new Worker( supervisorScript );
	this.dispatcher.linkPort( this.supervisor, true );

	/*
	 * Send configuration
	 */
	var supervisorConfiguration = {
		worker: this.cfg.worker,
		map: this.cfg.map
	};
	this.supervisor.postMessage({ command: supervisorProtocol.initialize, config: supervisorConfiguration });

	this.supervisor.addEventListener('error', function(problem){
		console.warn( "[supervisor] Encountered error: ", problem );
		var message = problem.message ? problem.message : "(unkonwn supervisor error)"; 
		var err = new Error( message );
		this.pendingPromises.forEach( function( promiseHandler ){
			promiseHandler({ succes:false, failure: err });
		});
		this.supervisor = null;
	}.bind(this));
}

Giraffe.prototype.feed = function( batch ){
	this.start();
	return this.dispatcher.withProgressAndReplyTo({ command: 'feed', batch: batch });
}

function web_giraffe( config ){ return new Giraffe( config ); }
