'use strict'
const
    net = require('net') 
    ,ioClient = require('socket.io-client')
    ,EventEmitter = require('events')
    ,stream = require('stream')
    ,uuid = require('uuid')
    ,portfinder = require('portfinder')
;

const Gateway = class extends EventEmitter
{

    #options =
    {
        settings:
        {
            tunnelingURL:'https://localhost:49153/tunnelingRequest'
            ,connManagerURL:'https://localhost:49153/tcpClientConn'
            ,portBlockList:[]
            ,timeout:60
            ,reqTimeout:30
            ,onlyLocalConn: true
            ,tcpConnAllowed:100
        }
        ,tcpServer:{}
        ,ioClient:{}
        ,ioTcpConn:{}
    };

    #tcpEvents =
    {
        connect: 'connect'
        ,ready: 'ready'
        ,pause: 'pause'
        ,drain: 'drain'
        ,close: 'close'
        ,data: 'data'
    }

    #staticEvents = 
    {
        tunnelReady:'tunneling_ready'
        ,tunnelRoomList:'room_list'
        ,connToRoomFailed:'connect_to_room_failed'
        ,tunnelReq: 'tunneling_request'
        ,tunnelContract: 'contract'
        ,connAddress:'connection_address'
        ,newConnection:'new_connection'
        ,tcpData:'tcp_data'
        ,userId:'user_id'
        ,userChannelConf:'user_channel_conf'
        ,tunnelReadyForSendData:'tunnel_ready_for_send_data'
    };

    #staticInternalEvents = 
    {
        error:'errors'
        ,warning:'warnings'
        ,info:'info'
        ,tunnelStatus:'tunnel_status'
        ,socketBytes:'socket_bytes'
        ,connPoints:'connection_points'
        ,connPointUnreachable:'connection_point_unreachable'
        ,gettedIp:'getted_ip'
        ,gateway:'gateway'
        ,idAssigned:'id_assigned'
        ,userChannel:'channel'
    };

    #internalMessages =
    {
        tunnelStatus:
        {
            ready:'tunnel ready'
            ,peerBroken:'peer tunnel broken'
            ,peerClose:'tunnel closed by peer'
            ,peerDown:'peer down'
            ,serverBroken:'server tunnel broken'
            ,serverClose:'tunnel closed by server'
            ,serverConnect:'connected with server'
            ,serverDown:'server down'
        }
    }

    #tunnel = null;
    #tcpServer = null;

    #socketList = {};

    #tryConnectWithRoom = false;
    #connClosed = false;
    #tunnelReady = false;
    #activeDevice = false; //agregado

    #waitingReconnection = setTimeout(()=>{}, 0);
    #timerScale = 1000; // in sec.

    #connectToRoom = null;
    #room = 'AR';
    #contract = null;
    #port = null;
    #userId = null;


    constructor(newOptions = {})
    {
        try
        {
            super();

            this.#setOptions(this.#options,newOptions);

            this.#tunnel = ioClient.connect(this.#options.settings.tunnelingURL,this.#options.ioClient);
            this.#tunnel.on(this.#staticEvents.tunnelReadyForSendData,()=>
            {
                if(this.#connectToRoom !== null && this.#connClosed){this.#tunnel.emit(this.#staticEvents.tunnelReq,this.#connectToRoom);};
                this.#connClosed = false;
            })

            this.#tunnel.on('error',(err)=>{this.emit(this.#staticInternalEvents.error,{type:'socket.io-client socket Error',error:err})})
            this.#tunnel.on('connect_error',(err)=>{this.emit(this.#staticInternalEvents.error,{type:'socket.io-client connection Error',error:err})})
            this.#tunnel.on('connect',(err)=>{this.emit(this.#staticInternalEvents.tunnelStatus,this.#internalMessages.tunnelStatus.serverConnect)})
            this.#tunnel.on(this.#staticEvents.userId,(id)=>
            {
                this.#userId = id;
                this.#tunnel.query.userID = id;
                this.emit(this.#staticInternalEvents.idAssigned,id);
            })

            this.#tunnel.on(this.#staticEvents.userChannelConf,(conf)=>{this.emit(this.#staticInternalEvents.userChannel,conf);})
            
            this.#tunnel.on(this.#staticEvents.tunnelReady,(ready,peerClosedMe)=>
            {
                try
                {
                    if(ready) 
                    {
                        clearTimeout(this.#waitingReconnection);
                        this.#activeDevice = true;
                        if(this.#connectToRoom !== this.#room) this.#room = this.#connectToRoom;
                        if(this.#tcpServer === null) this.#createTCPServer();
                        else 
                        { 
                            this.#tcpServer.getConnections((err,count)=>
                            {
                                if(err) this.emit(this.#staticInternalEvents.error,{type:'#tcpServer.getConnections Error',error:err})
                                if(count === 0) this.#tcpServer.maxConnections = this.#options.settings.tcpConnAllowed;
                            })
                        }
                        this.emit(this.#staticInternalEvents.tunnelStatus,this.#internalMessages.tunnelStatus.ready);
                    }
                    else if(peerClosedMe) this.emit(this.#staticInternalEvents.tunnelStatus,this.#internalMessages.tunnelStatus.peerClose)
                    else
                    {
                        this.#launchRConnTimer();
                        this.emit(this.#staticInternalEvents.tunnelStatus,this.#internalMessages.tunnelStatus.peerBroken)
                    }
                    this.#tunnelReady = ready;
                }
                catch(err){this.emit(this.#staticInternalEvents.error,{type:'tunnelReady Event Listener Error',error:err})}
            })
            
            this.#tunnel.on(this.#staticEvents.tunnelRoomList,(data)=>{this.emit(this.#staticInternalEvents.connPoints,data)})

            this.#tunnel.on(this.#staticEvents.connToRoomFailed,(reason)=>
            {
                try{this.emit(this.#staticInternalEvents.connPointUnreachable,reason)}
                catch(err){this.emit(this.#staticInternalEvents.error,{type:'connToRoomFailed Event Listener Error',error:err})}
            })
            this.#tunnel.on(this.#staticEvents.tunnelContract, (contract) => 
            {
                this.#contract = contract
                this.#tunnel.query.contract = contract;
            })
            this.#tunnel.on(this.#staticEvents.connAddress,(ip)=>
            {
                try{this.emit(this.#staticInternalEvents.gettedIp,ip)}
                catch(err){this.emit(this.#staticInternalEvents.error,{type:'connAddress Event Listener Error',error:err})}  
            })
            
            this.#tunnel.on('disconnect',(reason)=>
            {
                try
                {
                    if (reason === 'io server disconnect')
                    {
                        this.#connClosed = true;
                        this.emit(this.#staticInternalEvents.tunnelStatus,this.#internalMessages.tunnelStatus.serverClose);
                    }
                    else if(reason !== 'io client disconnect')
                    { 
                        this.emit(this.#staticInternalEvents.tunnelStatus,this.#internalMessages.tunnelStatus.serverBroken)
                        if(this.#activeDevice) this.#launchRConnTimer();
                    }
                    this.#tunnelReady = false;
                    this.emit(this.#staticInternalEvents.info,' tunnel disconnect');
                }
                catch(err){this.emit(this.#staticInternalEvents.error,{type:'disconnect Event Listener Error',error:err})}
            }) 

        }catch(err){this.emit(this.#staticInternalEvents.error,{type:'constructor Error',error:err})}
    }

    #setOptions = (curOptions,newOptions)=>
    {
        try
        {
            if (typeof newOptions === 'object') 
            {   
                let 
                    keyListNewOpts = Object.keys(newOptions)
                    ,keyListCurOpts = Object.keys(curOptions)
                ;
                for (let i = 0; i < keyListNewOpts.length; i++) 
                {
                    let finded = keyListCurOpts.findIndex((property)=>{return property === keyListNewOpts[i]});
                    if(finded !== -1 && typeof newOptions[keyListNewOpts[i]] === typeof curOptions[keyListNewOpts[i]])
                    {
                        if 
                        (
                            keyListNewOpts[i] === 'tcpServer' 
                            || keyListNewOpts[i] === 'ioClient'
                            || keyListNewOpts[i] === 'ioTcpConn'
                        ) curOptions[keyListNewOpts[i]] = newOptions[keyListNewOpts[i]];
                        else if(Array.isArray(newOptions[keyListNewOpts[i]]) && Array.isArray(curOptions[keyListNewOpts[i]])) 
                        {
                            curOptions[keyListNewOpts[i]] = newOptions[keyListNewOpts[i]].slice();
                        }
                        else if(typeof newOptions[keyListNewOpts[i]] === 'object') this.#setOptions(curOptions[keyListNewOpts[i]],newOptions[keyListNewOpts[i]]) 
                        else curOptions[keyListNewOpts[i]] = newOptions[keyListNewOpts[i]]
                    }
                    else this.emit(this.#staticInternalEvents.error,{type:'setOptions',error:'not valid options!! or value!! ' + keyListNewOpts[i]});
                    
                }
            }
            else this.emit(this.#staticInternalEvents.error,{type:'setOptions',error:'Not valid Options: ' + JSON.stringify(newOptions)});  
        }
        catch(err){this.emit(this.#staticInternalEvents.error,{type:'setOptions Error' ,error:err})}
    }

    #createTCPServer = ()=>
    {
        portfinder.getPortPromise()
        .then((port) => {
            this.#port = port;
            this.emit(this.#staticInternalEvents.gateway,{host:'localhost',port})
            this.#tcpServer = net.createServer(this.#options.tcpServer,this.#connectionListener);
            this.#tcpServer.maxConnections = this.#options.settings.tcpConnAllowed;
            this.#tcpServer
            .listen
            (
                port
                ,()=> this.emit(this.#staticInternalEvents.info,'tcp sever listen in port: ' + port)
            )
            ;
            this.#tcpServer.on('error', (err) => {this.emit(this.#staticInternalEvents.error,{type:'TCP sever error',error:err})});
        })
        .catch((err) => {this.emit(this.#staticInternalEvents.error,{type:'portfinder error',error:err})});      
    }

    #launchRConnTimer = () => 
    {   
        try
        {
            this.#waitingReconnection = setTimeout(() =>
            {
                if (this.#tunnel.connected && this.#activeDevice) this.emit(this.#staticInternalEvents.tunnelStatus,this.#internalMessages.tunnelStatus.peerDown)
                else if(!this.#tunnel.connected)
                {
                    this.#connClosed = true;
                    this.emit(this.#staticInternalEvents.tunnelStatus,this.#internalMessages.tunnelStatus.serverDown);
                    this.#closeTunnel();
                }
            },this.#options.settings.timeout*this.#timerScale)
        }
        catch(err){this.emit(this.#staticInternalEvents.error,{type:'launchRConnTimer Error' ,error:err})}
    }

    #connectionListener = (socket)=>
    {
        try
        {
           if
            (
                this.#options.settings.onlyLocalConn
                && socket.remoteAddress !== '::1'
                && socket.remoteAddress !== '::ffff:127.0.0.1'
            )
            {socket.destroy();}
            else
            {
                let 
                    connectionID = uuid.v4()
                    ,options = Object.assign({},this.#options.ioTcpConn)
                    ,wsConn = null
                    ,connected = false
                    ,read = true
                    ,payload = null
                    ,expirationTimer = setTimeout(()=>{if(wsConn !== null) wsConn.disconnect()},this.#options.settings.reqTimeout*this.#timerScale);
                ;

                options.query = Object.assign({},this.#options.ioClient.query); 
                options.query.userID = this.#userId;
                options.query.connectionID = connectionID;
                options.query.contract = this.#contract;
                options.query.country = this.#room;

                wsConn = ioClient(this.#options.settings.connManagerURL,options);
                wsConn.autoConnect = false;
                this.#socketList[connectionID] = socket;
                wsConn.on('connect_error',()=>{socket.destroy(); wsConn.disconnect(); wsConn.removeAllListeners();})

                wsConn.on(this.#staticEvents.tcpData,(data)=>
                {
                    try
                    {
                        switch (data.event) 
                        {
                            case this.#tcpEvents.connect :
                                connected = true;
                                break;
                            case this.#tcpEvents.ready :
                                clearTimeout(expirationTimer);
                                if(payload !== null) wsConn.emit(this.#staticEvents.tcpData,{event:this.#tcpEvents.data,pakg:payload})
                                else socket.write('HTTP/1.1 200 OK \r\n\r\n');
                                break;
                            case this.#tcpEvents.pause :
                                socket.pause();
                                break;
                            case this.#tcpEvents.drain :
                                read = true;
                                socket.resume();
                                break;
                            case this.#tcpEvents.close :
                                socket.destroy();
                                break;
                            default :
                                if(!socket.destroyed)
                                {
                                    let flushed = socket.write(data.pakg);
                                    if(!flushed) wsConn.emit(this.#staticEvents.tcpData,{connectionID,event:this.#tcpEvents.pause});
                                    else {wsConn.emit(this.#staticEvents.tcpData,{event:this.#tcpEvents.drain});}
                                }
                        }
                    }
                    catch(err){this.emit(this.#staticInternalEvents.error,{type:'tcpData Event Listener Error' ,error:err})}
                });

                wsConn.on('disconnect',(reason) => 
                {
                    socket.destroy(); 
                    if(reason === 'transport close' || reason === 'transport error' || reason === 'ping timeout') wsConn.disconnect();
                    wsConn.removeAllListeners();
                })

                socket.on('drain',() =>{wsConn.emit(this.#staticEvents.tcpData,{event:this.#tcpEvents.drain});})
                socket.on('error',(err) => {this.emit(this.#staticInternalEvents.error,{type:'TCP socket error',error:err})})
                socket.on('close',() =>
                {
                    wsConn.emit(this.#staticEvents.tcpData,{event:this.#tcpEvents.close})
                    wsConn.disconnect();
                    wsConn.removeAllListeners();
                    this.emit(this.#staticInternalEvents.socketBytes,{read:socket.bytesRead,write:socket.bytesWritten})
                    delete this.#socketList[connectionID]
                    clearTimeout(expirationTimer);
                })
                
                socket.on('data',(data) => 
                {        
                    if(!connected) 
                    {
                        let req = this.#validateReq(data);
                        if(req.data.payload !== null) 
                        {
                            payload = req.data.payload;
                            req.data.payload = null;
                        }

                        delete req.data.payload;
                        
                        if(!socket.destroyed) wsConn.emit(this.#staticEvents.tcpData,{event:this.#staticEvents.newConnection,data:req.data}); 
                    }
                    else 
                    {
                        wsConn.emit(this.#staticEvents.tcpData,{event:this.#tcpEvents.data,pakg:data})
                        if(read) read = false;
                        else socket.pause();
                    }        
                })
           }
        }
        catch(err){this.emit(this.#staticInternalEvents.error,{type:'connectionListener Error' ,error:err})}
    }
    
    #closeTunnel = ()=>
    {
        try
        {
            this.#tunnel.autoConnect = false;
            this.#tunnel.disconnect();
        }
        catch(err){this.emit(this.#staticInternalEvents.error,{type:'closeTunnel Error' ,error:err})}
    }


    #removeListeners = (obj,evntList = {},separator = null,connectionID = null) =>
    {
        try
        {
            if (Object.keys(evntList).length === 0) obj.removeAllListeners()
            else
            {   
                for (let evnt in evntList) 
                {
                    if (separator === null && connectionID === null) obj.removeAllListeners(evntList[evnt])
                    else obj.removeAllListeners(evntList[evnt]+separator+connectionID);
                }
            }
        }
        catch(err){this.emit(this.#staticInternalEvents.error,{type:'removeListeners Error' ,error:err})}  
    }

    #validateReq = (data)=>
    {
        try
        {
            const expListForHost =
            {
                connect: /CONNECT (.+(:[0-9]+)?) HTTP/i
                ,host: /Host: (.+(:[0-9]+)?)\r\n/i
            };
            let 
                match = null
                ,keys = Object.keys(expListForHost)
                ,index = 0
                ,isConnectMethod = true
            ;
            while(match === null && index < keys.length)
            {
                match = (data + '').match(expListForHost[keys[index]]);
                if (match !== null && keys[index] !== 'connect') isConnectMethod = false;
                index++;
            } 
            if(match === null) return {valid:false,type:'TCP Socket Warning',error:'Bad Request'}
            else
            {
                let 
                    split = match[1].split(':')
                    ,host = split[0]
                    ,port = split.length < 2 ? 80 : parseInt(split[1])
                    ,payload = null
                ;

               if (!isConnectMethod){payload = data}

                if (this.#validPort(port)) return {valid:true,data:{host,port,payload}}
                else return {valid:false,type:'TCP socket warning',error:'Invalid Port'}
            }
        }
        catch(err){this.emit(this.#staticInternalEvents.error,{type:'validateReq Error' ,error:err})} 
    }

    #validPort = (port)=>
    {
        try
        {
            let valid = true;
            if(port < 0 && port > 65535) return valid = false;
            for (let i = 0; i < this.#options.settings.portBlockList.length; i++) 
            {
                if(this.#options.settings.portBlockList[i] === port)
                {
                    valid = false;
                    break;
                }
            }
            return valid;
        }
        catch(err){this.emit(this.#staticInternalEvents.error,{type:'validPort Error' ,error:err})}
    }

    #closeSockets = (sList)=>
    {
        try
        {
            if(Array.isArray(sList))
            {
                let listLen = sList.length;
                for(let i = 0; i < listLen;i++)
                {
                    delete sList[i].id;
                    delete sList[i].req;
                    sList[i].destroy();
                }
            }
            else for(let socket in sList) sList[socket].destroy();    
        }
        catch(err){this.emit(this.#staticInternalEvents.error,{type:'closeSocket Error' ,error:err})}
    }

    eventsList(){return Object.keys(this.#staticInternalEvents)}
    addEvent(evnt,cb)
    {
        try
        {
            if (Array.isArray(evnt)) 
                for(let i = 0; i < evnt.length; i++) 
                    this.on(evnt[i],cb);
            else this.on(evnt,cb);
        }
        catch(err){this.emit(this.#staticInternalEvents.error,{type:'addEvent Error' ,error:err})} 
    }

    removeEvent(evnt)
    {
        try
        {
            let 
                evntList = {}
                ,auxEvntArr = null
            ;
            if (Array.isArray(evnt)) auxEvntArr = evnt;
            else auxEvntArr = [evnt];

            for(let i = 0; i < auxEvntArr.length; i++)
                for (let e in this.#staticInternalEvents)
                    if(this.#staticInternalEvents[e] === auxEvntArr[i])
                        evntList[e] = auxEvntArr[i];

            this.#removeListeners(this,evntList);

        }
        catch(err){this.emit(this.#staticInternalEvents.error,{type:'removeEvent Error' ,error:err})}
    }

    checkConnectionPoints()
    {
        try
        {
            if(this.#connClosed) this.#tunnel.connect();
            this.#tunnel.emit(this.#staticEvents.tunnelRoomList);
        }
        catch(err){this.emit(this.#staticInternalEvents.error,{type:'checkConnectionPoints Error', error:err})}
    }

    connectTo(point)
    {
        try
        {
            if(typeof point === 'string')
            {
                clearTimeout(this.#waitingReconnection);
                this.#connectToRoom = point.toUpperCase();    
                if(this.#connClosed) this.#tunnel.connect();
                else this.#tunnel.emit(this.#staticEvents.tunnelReq,this.#connectToRoom);
            } else this.emit(this.#staticInternalEvents.error,{type:'connectTo Error', error:'point must be an string'})
        }
        catch(err){this.emit(this.#staticInternalEvents.error,{type:'connectTo Error', error:err})}
    }
    
    changeCredentials(credentials)
    {
        if(credentials.user) this.#tunnel.query.user = credentials.user;
        if(credentials.pass) this.#tunnel.query.pass = credentials.pass;
    }
    
    close()
    {
       try
       {
            if(this.#tcpServer !== null) this.#tcpServer.close();
            this.#removeListeners(this,this.#staticInternalEvents)
            this.emit(this.#staticInternalEvents.info,'TCP Server Closed');
            this.#closeTunnel();
            clearTimeout(this.#waitingReconnection);
            this.#closeSockets(this.#socketList);
            this.#removeListeners(this.#tunnel)
            this.#removeListeners(this)

        }
        catch(err){this.emit(this.#staticInternalEvents.error,{type:'close Error', error:err})}
    }
}

module.exports = Gateway;
