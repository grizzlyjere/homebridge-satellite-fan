'use strict'

//const util = require('util')

const Noble = require('noble'),
  EventEmitter = require('events').EventEmitter;

  var mqtt = require('mqtt');

  var fsConfig = require('fs');
  this.loadedConfig = JSON.parse(fsConfig.readFileSync('./config.json', 'utf8'));

  var server = this.loadedConfig.mqttServer;
  var MqttTopicBase = this.loadedConfig.topicBase;
  var MqttTopicStatus = MqttTopicBase + "$online";
  var MqttTopicFanSpeed = MqttTopicBase + "fan/speed";
  var MqttTopicFanSpeedSet = MqttTopicFanSpeed + "/set";
  var MqttTopicFanOn = MqttTopicBase + "fan/on";
  var MqttTopicFanOnSet = MqttTopicFanOn + "/set";
  var MqttTopicLightOn = MqttTopicBase + "light/on";
  var MqttTopicLightOnSet = MqttTopicLightOn + "/set";
  var MqttTopicLightBrightness = MqttTopicBase + "light/brightness";
  var MqttTopicLightBrightnessSet = MqttTopicLightBrightness + "/set";

  var Characteristic = {Brightness: 0, On: true, RotationSpeed: 100}

  var useFanSpeedWords = this.loadedConfig.useFanSpeedWords;
  var remapMaxBrightness = this.loadedConfig.remapMaxBrightness;
  var fanOnStateValue = this.loadedConfig.fanOnStateValue;
  var fanOffStateValue = this.loadedConfig.fanOffStateValue;
  var lightOnStateValue = this.loadedConfig.lightOnStateValue;
  var lightOffStateValue = this.loadedConfig.lightOffStateValue;

  var fsLogging = require('fs');
  var Log = require('log');
  var outputLog = new Log('debug', fsLogging.createWriteStream(this.loadedConfig.logFile));
  outputLog.info("Log Start");

  function trimAddress(address) {
    return address.toLowerCase().replace(/:/g, "")
  }
  
  function trimUUID(uuid) {
    return uuid.toLowerCase().replace(/:/g, "").replace(/-/g, "")
  }

  function mapRange(value, low1, high1, low2, high2) {
    //console.log("value: " + value);
    //console.log("low1: " + low1);
    //console.log("high1: " + high1);
    //console.log("low2: " + low2);
    //console.log("high2: " + high2);
    //console.log("RESULT: " + (low2 + (((high2 - low2) * (value - low1)) / (high1 - low1))))
    return (low2 + (((high2 - low2) * (value - low1)) / (high1 - low1)));
  }
  
  class FanRequest {
  
    writeInto(buffer) {
      throw new TypeError('Must override method')
    }
  
    toPrefixedBuffer(prefix) {
      //console.log("toPrefixedBuffer: " + prefix)
      var buffer
      if (prefix > 0) {
        
        buffer = new Buffer(13)
        buffer.writeUInt8(prefix)
        this.writeInto(buffer.slice(1))
      } else {
        buffer = new Buffer(12)
        this.writeInto(buffer)
      }
  
      const checksum = buffer.slice(0, buffer.length - 1).reduce(function(a, b){
        return a + b
      }, 0) & 255
  
      buffer.writeUInt8(checksum, buffer.length - 1)
      return buffer
    }
  
  }
  
  class FanGetStateRequest extends FanRequest {
  
    writeInto(buffer) {
      buffer.fill(0)
      buffer.writeUInt8(160)
    }
  
  }
  
  Math.clamp = function(number, min, max) {
    return Math.max(min, Math.min(number, max))
  }
  
  class FanUpdateLightRequest extends FanRequest {
  
    constructor(isOn, level) {
      super()
      this.on = isOn ? 1 : 0
      this.level = Math.clamp(level, 0, 100)
    }
  
    writeInto(buffer) {
      buffer.fill(0)
      buffer.writeUInt8(161)
      buffer.writeUInt8(255, 4)
      buffer.writeUInt8(100, 5)
      buffer.writeUInt8((this.on << 7) | this.level, 6)
      buffer.fill(255, 7, 10)
    }
  
  }
  
  class FanUpdateLevelRequest extends FanRequest {
  
    constructor(level) {
      super()
      this.level = Math.clamp(level, 0, 3)
    }
  
    writeInto(buffer) {
      buffer.fill(0)
      buffer.writeUInt8(161)
      buffer.writeUInt8(this.level, 4)
      buffer.fill(255, 5, 10)
    }
  
  }
  
  class FanResponse {
  
    static get Keys() { return {
      FAN_LEVEL: 'fanLevel',
      FAN_SPEED: 'fanSpeed',
      LIGHT_ON: 'lightIsOn',
      LIGHT_BRIGHTNESS: 'lightBrightness'
    } }
  
    static fromPrefixedBuffer(prefix, buffer) {
      if (prefix > 0) {
        buffer = buffer.slice(1)
      }
  
      if (buffer.readUInt8(0) != 176) { return null }
      const response = new FanResponse()
  
      const windVelocity       = buffer.readUInt8(2)
      response.fanLevelMaximum = windVelocity & 0b00011111
  
      const currentWindVelocity = buffer.readUInt8(4)
      response.fanLevel         = currentWindVelocity & 0b00011111
  
      const currentBrightness  = buffer.readUInt8(6)
      response.lightIsOn       = (currentBrightness & 0b10000000) != 0
      response.lightBrightness = (currentBrightness & 0b01111111)
  
      return response
    }
  
    get fanSpeed() {
      return (this.fanLevel / this.fanLevelMaximum) * 100
    }
  
  }
  
  // MARK: -
  
  class FanLightAccessory extends EventEmitter {
  
    constructor (log, config) {
      super()
  
      this.onDiscover = this.onDiscover.bind(this)
  
      this.log = log
      this.name = config.name || "Ceiling Fan"
      if (!config.address) {
        throw new Error(this.prefix + " Missing mandatory config 'address'")
      }
      this.address = trimAddress(config.address)
      if (!config.ble) {
        throw new Error(this.prefix + " Missing mandatory config 'ble'")
      }
      this.manufacturerPrefix = config.ble.prefix || 0
      if (!config.ble.serviceUUID) {
        throw new Error(this.prefix + " Missing mandatory config 'ble.serviceUUID'")
      }
      this.serviceUUID = trimUUID(config.ble.serviceUUID)
      if (!config.ble.writeCharacteristicUUID) {
        throw new Error(this.prefix + " Missing mandatory config 'ble.writeCharacteristicUUID'")
      }
      this.writeCharacteristicUUID = trimUUID(config.ble && config.ble.writeCharacteristicUUID)
      this.writeCharacteristic = null
      if (!config.ble.notifyCharacteristicUUID) {
        throw new Error(this.prefix + " Missing mandatory config 'ble.notifyCharacteristicUUID'")
      }
      this.notifyCharacteristicUUID = trimUUID(config.ble && config.ble.notifyCharacteristicUUID)
      this.notifyCharacteristic = null
  
      this.fanLevelMaximum = 3
  
      this.mqttClient  = mqtt.connect(server,{will: {topic: MqttTopicStatus, payload: "false", retain:true, qos:2 }})

      this.mqttClient.on('connect', this.onDidFinishLaunching.bind(this));

      this.mqttClient.on('message', this.mqttMessageReceived.bind(this));
      
    }

    mqttMessageReceived (topic, message) 
    {
      // message is Buffer
      console.log("Message Received: " + topic + ">>" + message.toString())

      switch(topic)
      {
        case MqttTopicFanSpeedSet:
          var level = 0
          if(useFanSpeedWords)
          {
            //console.log("Using fan speed words: " + message);
            if(message == "off")
              {
                level = 0;
              }
            if(message == "low")
              {
                level = 1;
              }
            if(message == "medium")
              {
                level = 2;
              }
            if(message == "high")
              {
                level = 3;
              }
          }
          else
          {
            level = parseInt(message,10)
            if(level >= 3)
            {
              level = 3;
            }
          }

          console.log("  Setting fan to: " + level)
          var requestFanSpeed = new FanUpdateLevelRequest(level)
          this.sendCommand(requestFanSpeed, this.sendCommandCallbackTest.bind(this))
          break;
          
        case MqttTopicFanOnSet:
          var targetFanLevel = 0
          if(message.toString().toLowerCase() == fanOnStateValue.toLowerCase())
          {
            targetFanLevel = 1;
          }
          console.log("  Setting fan to: " + targetFanLevel)
          var requestFanOnOff = new FanUpdateLevelRequest(targetFanLevel)
          this.sendCommand(requestFanOnOff, this.sendCommandCallbackTest.bind(this))
          
          break;
        case MqttTopicLightOnSet:
          var targetLightStatus = false
          var targetLightLevel = 0
          if(message.toString().toLowerCase() == lightOnStateValue.toLowerCase())
          {
            targetLightStatus = true;
            targetLightLevel = 100
            // TODO: Retail the last on value to restore to that
          }
          var requestLightOnOff = new FanUpdateLightRequest(targetLightStatus,targetLightLevel)
          this.sendCommand(requestLightOnOff, this.sendCommandCallbackTest.bind(this))
          break;
        case MqttTopicLightBrightnessSet:
          var lightLevel = 0
          lightLevel = parseInt(message,10)
          var remapMaxValue = remapMaxBrightness
          if(remapMaxValue <= 0)
          {
            remapMaxValue = 100
          }

          lightLevel = Math.round(mapRange(lightLevel,0,remapMaxValue,0,100));

          if(lightLevel >= 100)
          {
            lightLevel = 100;
          }

          var requestLightDimmer;

          if(lightLevel < 0)
          {
            lightLevel = 0
            //console.log("Log Brightness: false/" + lightLevel);
             //requestLightDimmer = new FanUpdateLevelRequest(false,lightLevel)
             requestLightDimmer = new FanUpdateLightRequest(false,lightLevel)
             
          }
          else
          {
            //console.log("Log Brightness: true/" + lightLevel);
             //requestLightDimmer = new FanUpdateLevelRequest(true,lightLevel)
             requestLightDimmer = new FanUpdateLightRequest(true,lightLevel)
          }
          
          
          this.sendCommand(requestLightDimmer, this.sendCommandCallbackTest.bind(this))

          break;
        default:
          break;
      }
      
    }

    sendCommandCallbackTest(item)
    {
      //console.log("sendCommandCallbackTest: " + item)
    }

  
    identify (callback) {
      this.log('Device identified!')
      callback()
    }
  
    startScanningWithTimeout() {
      Noble.startScanning([], true)
  
      setTimeout(function() {
        if (Noble.listenerCount('discover') == 0) { return }
        this.log.debug('Discovery timeout')
        Noble.stopScanning()
      }.bind(this), 12500)
    }
  
    stopScanning() {
      Noble.removeListener('discover', this.onDiscover)
      if (Noble.listenerCount('discover') == 0) {
        Noble.removeAllListeners('scanStop')
        Noble.stopScanning()
      }
    }
  
    fanSpeedToLevel(value) {
      return Math.ceil(value * (this.fanLevelMaximum / 100))
    }
  
    sendCommand(command, callback) {
      if (!this.notifyCharacteristic || !this.writeCharacteristic) {
        this.log.info('waiting on connect...')
        this.once('ready', function() {
          this.sendCommand(command, callback)
        }.bind(this))
        return
      }
  
      const buffer = command.toPrefixedBuffer(this.manufacturerPrefix)
      this.log.debug('will send', this.manufacturerPrefix, buffer)
      this.writeCharacteristic.write(buffer, false, function(error){
        if (!error) {
          this.log.debug('sent')
        }
        callback(error)
      }.bind(this))
    }
  
    sendUpdateStateRequest() {
      this.log.info('coalesced update request')
      const command = new FanGetStateRequest()
      this.sendCommand(command, function(error){
        if (!error) { return }
        this.emit('updateState', error)
      }.bind(this))
    }
  
    // MARK: -
  
    onDidFinishLaunching() {
      console.log("MQTT Connected")
      this.log.info("Received did finish launching")
      this.mqttClient.publish(MqttTopicStatus,"true")
      this.mqttClient.subscribe(MqttTopicLightOnSet)
      this.mqttClient.subscribe(MqttTopicLightBrightnessSet)
      this.mqttClient.subscribe(MqttTopicFanSpeedSet)
      this.mqttClient.subscribe(MqttTopicFanOnSet)
      Noble.on('stateChange', this.onAdapterChange.bind(this))
    }
  
    onAdapterChange(state) {
      Noble.removeAllListeners('scanStop')
      Noble.stopScanning()
  
      if (state != 'poweredOn') {
        this.log.debug("Stopped scanning: " + state)
        return
      }
  
      this.log.debug('Starting scan')
  
      Noble.on('scanStop', function() {
        setTimeout(function() {
          this.log.debug('Restart from scan stop')
          this.startScanningWithTimeout()
        }.bind(this), 2500)
      }.bind(this))
  
      Noble.on('discover', this.onDiscover)
      this.log.debug('discover count ', Noble.listenerCount('discover'))
      this.startScanningWithTimeout()
    }
  
    onDiscover(peripheral) {
      if (trimAddress(peripheral.address) !== this.address || (this.writeCharacteristic && this.notifyCharacteristic)) {
        this.log.debug("Ignoring " + peripheral.address + " (RSSI " + peripheral.rssi + "dB)")
        return
      }
  
      this.log.debug("Found " + peripheral.address + " (RSSI " + peripheral.rssi + "dB)")
      this.stopScanning()
      peripheral.connect(function(error) {
        this.onConnect(error, peripheral)
      }.bind(this))
    }
  
    onConnect(error, peripheral) {
      if (error) {
        this.log.error("Connecting to " + peripheral.address + " failed: " + error)
        this.onDisconnect(error, peripheral)
        return
      }
      this.log.debug("Connected to " + peripheral.address)

      // Poll the device for status
      // TODO: Make the interval configurable
      var pollingInterval = 2000
      this.pollingReference = setInterval(this.requestFullUpdate.bind(this), pollingInterval)
      console.log("Sending updates to MQTT every " + pollingInterval + " milliseconds")
      
      peripheral.discoverSomeServicesAndCharacteristics([ this.serviceUUID ], [ this.writeCharacteristicUUID, this.notifyCharacteristicUUID ], this.onDiscoverCharacteristics.bind(this));
      peripheral.once('disconnect', function(error) {
        this.onDisconnect(error, peripheral)
      }.bind(this))
    }

    requestFullUpdate()
    {
      this.getLightOn(this.processLightStatus.bind(this))
      this.getLightBrightness(this.processLightBrightness.bind(this))
      this.getFanOn(this.processFanStatus.bind(this))
      this.getFanRotationSpeed(this.processFanSpeed.bind(this))
      //console.log("Requesting Update...")
    }

    processLightStatus(errorObject, responseObject)
    {
      if(typeof (responseObject) == typeof (true)){
        var transmitValue = "";
        if(responseObject)
        {
          transmitValue = lightOnStateValue;
        }
        else
        {
          transmitValue = lightOffStateValue;
        }

        //console.log("Publishing Light Status to: " + MqttTopicLightOn + " [" + transmitValue + "]")
        this.mqttClient.publish(MqttTopicLightOn,transmitValue)
      }
      
    }

    //lightLevel = mapRange(lightLevel,0,remapMaxValue,0,100)

    processLightBrightness(errorObject, responseObject)
    {
      if(typeof (responseObject) == "number"){
        var lightLevel = Math.round(mapRange(responseObject,0,100,0,remapMaxBrightness,0));
        
        //console.log("Publishing Light Brightness to: " + MqttTopicLightBrightness + " [" + lightLevel + "]")

        this.mqttClient.publish(MqttTopicLightBrightness,lightLevel.toString())
      }
      else
      {
        this.mqttClient.publish(MqttTopicLightBrightness,"ERROR")
      }
    }

    processFanStatus(errorObject, responseObject)
    {

      if(typeof (responseObject) == typeof (true)){
        //console.log("Publishing Fan Status to: " + MqttTopicFanOn + " [" + responseObject.toString() +  "]")
        var transmitValue = "";
        if(responseObject)
        {
          transmitValue = fanOnStateValue;
        }
        else
        {
          transmitValue = fanOffStateValue;
        }
        //console.log(" Actual transmitted value: " + transmitValue);
        this.mqttClient.publish(MqttTopicFanOn,transmitValue)
      }
      else
      {
        this.mqttClient.publish(MqttTopicFanOn,"ERROR")
      }
    }

    processFanSpeed(errorObject, responseObject)
    {

      if(typeof (responseObject) == "number"){
        //console.log("Publishing Fan Speed to: " + MqttTopicFanSpeed + " [" + responseObject.toString() +  "]")
        var transmitValue = "";
        if(useFanSpeedWords)
        {
          if(responseObject.toString().startsWith("0"))
          {
            transmitValue = "off"
          }
          if(responseObject.toString().startsWith("33"))
          {
            transmitValue = "low"
          }
          if(responseObject.toString().startsWith("66"))
          {
            transmitValue = "medium"
          }
          if(responseObject.toString().startsWith("1"))
          {
            transmitValue = "high"
          }
        }
        else
        {
          transmitValue = responseObject.toString();
        }
        //console.log("  Actual Transmit Value: " + transmitValue)
        this.mqttClient.publish(MqttTopicFanSpeed,transmitValue)
        
      }
      else
      {
        this.mqttClient.publish(MqttTopicFanSpeed,"ERROR")
      }
    }
  
    onDisconnect(error, peripheral) {

      if(this.pollingReference)
      {
        clearImmediate(this.pollingReference)
      }

      if (this.writeCharacteristic) {
        this.writeCharacteristic.removeAllListeners('set')
      }
      this.writeCharacteristic = null
  
      if (this.notifyCharacteristic) {
        this.notifyCharacteristic.unsubscribe(null)
        this.notifyCharacteristic.removeAllListeners('data')
      }
      this.notifyCharacteristic = null
  
      peripheral.removeAllListeners()
  
      this.log.info("Disconnected")
  
      this.onDiscover(peripheral)
  
      if (this.listenerCount('updateState') != 0) {
        this.sendUpdateStateRequest()
      }
    }
  
    onDiscoverCharacteristics(error, services, characteristics) {
      if (error || characteristics.count < 2) {
        this.log.error(this.prefix, "Discover services failed: " + error)
        return
      }
  
      const writeCharacteristic = characteristics[0],
        notifyCharacteristic = characteristics[1]
  
      notifyCharacteristic.on('data', this.onNotify.bind(this))
      notifyCharacteristic.subscribe(function (error) {
        if (error) {
          this.log.warn("Subscribe to notify characteristic failed")
        }
  
        this.writeCharacteristic = writeCharacteristic
        this.notifyCharacteristic = notifyCharacteristic
  
        this.log.info("Ready")
        this.emit('ready')
      }.bind(this))
    }
  
    onNotify(data, isNotification) {
      const response = FanResponse.fromPrefixedBuffer(this.manufacturerPrefix, data)
      if (!response) { return }
      this.log.debug('received fan state')
  
      this.fanLevelMaximum = response.fanLevelMaximum
  
      this.emit('updateState', null, response)
  
    }
  
    // MARK: -
  
    getNextValueForFanState(key, callback) {
      const shouldSend = this.listenerCount('updateState') == 0
  
      this.once('updateState', function(error, response) {
        if (error) {
          callback(error, null)
        } else {
          callback(null, response[key])
        }
      })
  
      if (shouldSend) {
        this.sendUpdateStateRequest()
      } else {
        this.log.debug('Skipping send update')
      }
    }
  
    enqueueWriteForDependentValue(service, characteristic, produceCommand, callback) {
      if (!this.notifyCharacteristic || !this.writeCharacteristic) {
        this.log.debug('Defer write for ready')
        this.once('ready', function() {
          this.log.debug('Dequeue write from ready')
          this.enqueueWriteForDependentValue(service, characteristic, produceCommand, callback)
        }.bind(this))
        return
      }
  
      if (this.listenerCount('updateState') != 0) {
        this.log.debug('Defer write for update state')
        this.once('updateState', function() {
          this.log.debug('Dequeuing write from update state')
          this.enqueueWriteForDependentValue(service, characteristic, produceCommand, callback)
        }.bind(this))
        return
      }
  
      if (this.writeCharacteristic.listenerCount('write') >= 1) {
        this.log.debug('Defer write for active write')
        this.writeCharacteristic.once('write', function() {
          this.log.debug('Dequeue write from active write')
          this.enqueueWriteForDependentValue(service, characteristic, produceCommand, callback)
        }.bind(this))
        return
      }
  
      const command = produceCommand(service.getCharacteristic(characteristic).value)
      this.sendCommand(command, callback)
    }
  
    getFanOn(callback) {
      this.getNextValueForFanState(FanResponse.Keys.FAN_LEVEL, function(error, level) {
        callback(error, error ? null : level != 0)
      }.bind(this))
    }
  
    setFanOn(newValue, callback) {
      this.log.info('Fan on: ' + newValue)
  
      if (!newValue) {
        const command = new FanUpdateLevelRequest(0)
        this.sendCommand(command, callback)
        return
      }
  
      this.enqueueWriteForDependentValue(this.fanService, Characteristic.RotationSpeed, function(currentSpeed){
        const level = this.fanSpeedToLevel(currentSpeed)
        this.log.debug('Using current level: ' + level)
  
        return new FanUpdateLevelRequest(level)
      }.bind(this), callback)
    }
  
    getFanRotationSpeed(callback) {
      this.getNextValueForFanState(FanResponse.Keys.FAN_SPEED, callback)
    }
  
    setFanRotationSpeed(newValue, callback) {
      const level = this.fanSpeedToLevel(newValue)
      this.log.info('Fan speed: ' + level)
  
      const command = new FanUpdateLevelRequest(level)
      this.sendCommand(command, callback)
    }
  
    getLightOn(callback) {
      this.getNextValueForFanState(FanResponse.Keys.LIGHT_ON, callback)
    }
  
    setLightOn(newValue, callback) {
      this.log.info('Light on: ' + newValue)
  
      this.enqueueWriteForDependentValue(this.lightService, Characteristic.Brightness, function(currentBrightness) {
        this.log.debug('Using current brightness: ' + currentBrightness)
        return new FanUpdateLightRequest(newValue, currentBrightness)
      }.bind(this), callback)
    }
  
    getLightBrightness(callback) {
      this.getNextValueForFanState(FanResponse.Keys.LIGHT_BRIGHTNESS, callback)
    }
  
    setLightBrightness(newValue, callback) {
      this.log.info('Light brightness: ' + newValue)
  
      this.enqueueWriteForDependentValue(this.lightService, Characteristic.On, function(currentlyOn) {
        return new FanUpdateLightRequest(currentlyOn, newValue)
      }, callback)
    }
  
  }

  var fn = new FanLightAccessory(outputLog,this.loadedConfig)

