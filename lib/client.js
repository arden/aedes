'use strict'

var Buffer = require('safe-buffer').Buffer
var mqtt = require('mqtt-packet')
var EE = require('events').EventEmitter
var util = require('util')
var eos = require('end-of-stream')
var empty = Buffer.allocUnsafe(0)
var Packet = require('aedes-packet')
var write = require('./write')
var QoSPacket = require('./qos-packet')
var handleSubscribe = require('./handlers/subscribe')
var handleUnsubscribe = require('./handlers/unsubscribe')
var handle = require('./handlers')

module.exports = Client

function Client (broker, conn) {
  var that = this

  this.broker = broker
  this.conn = conn
  this.parser = mqtt.parser()
  this.connected = false
  this.errored = false
  this.clean = true
  this._handling = 0
  this.subscriptions = {}
  this.id = null

  conn.client = this

  this.parser.client = this

  this.duplicates = {}
  this._parsingBatch = 1
  this._nextId = Math.ceil(Math.random() * 65535)

  this.disconnected = false

  this.parser.on('packet', enqueue)

  function nextBatch (err) {
    if (err) {
      return that.emit('error', err)
    }

    var buf = empty
    var client = that

    that._parsingBatch--
    if (that._parsingBatch <= 0) {
      that._parsingBatch = 0
      buf = client.conn.read(null)

      if (buf) {
        client.parser.parse(buf)
      }
    }
  }
  this._nextBatch = nextBatch

  nextBatch()

  conn.on('readable', nextBatch)
  conn.on('error', this.emit.bind(this, 'error'))
  this.parser.on('error', this.emit.bind(this, 'error'))

  this.on('error', onError)

  this._eos = eos(this.conn, this.close.bind(this))

  function dedupe (packet) {
    var duplicates = that.duplicates
    var id = packet.brokerId
    if (!id) {
      return true
    }
    var counter = packet.brokerCounter
    var result = (duplicates[id] || 0) < counter
    if (result) {
      duplicates[id] = counter
    }
    return result
  }

  this.deliver0 = function deliverQoS0 (_packet, cb) {
    var toForward = dedupe(_packet) &&
      that.broker.authorizeForward(that, _packet)
    if (toForward) {
      var packet = new Packet(toForward, broker)
      packet.qos = 0
      write(that, packet, cb)
    } else {
      cb()
    }
  }

  this.deliverQoS = function deliverQoS (_packet, cb) {
    // downgrade to qos0 if requested by publish
    if (_packet.qos === 0) {
      that.deliver0(_packet, cb)
    } else {
      var toForward = dedupe(_packet) &&
        that.broker.authorizeForward(that, _packet)
      if (toForward) {
        var packet = new QoSPacket(toForward, that)
        packet.writeCallback = cb
        if (that.clean) {
          writeQoS(null, that, packet)
        } else {
          broker.persistence.outgoingUpdate(that, packet, writeQoS)
        }
      } else if (that.clean === false) {
        that.broker.persistence.outgoingClearMessageId(that, _packet, nop)
        // we consider this to be an error, since the packet is undefined
        // so there's nothing to send
        cb()
      } else {
        cb()
      }
    }
  }

  this._keepaliveTimer = null
  this._keepaliveInterval = -1

  this._connectTimer = setTimeout(function () {
    that.emit('error', new Error('connect did not arrive in time'))
  }, broker.connectTimeout)
}

function writeQoS (err, client, packet) {
  if (err) {
    // is this right, or we should ignore thins?
    client.emit('error', err)
  } else {
    write(client, packet, packet.writeCallback)
  }
}

function drainRequest (req) {
  req.callback()
}

function onError (err) {
  this.errored = true
  this.conn.removeAllListeners('error')
  this.conn.on('error', nop)
  this.broker.emit('clientError', this, err)
  this.close()
}

util.inherits(Client, EE)

Client.prototype._onError = onError

Client.prototype.publish = function (message, done) {
  var packet = new Packet(message, this.broker)
  var that = this
  if (packet.qos === 0) {
    // skip offline and send it as it is
    this.deliver0(packet, done || nop)
  } else if (!this.clean && this.id) {
    this.broker.persistence.outgoingEnqueue({
      clientId: this.id
    }, packet, function deliver (err) {
      if (err) {
        return done(err)
      }
      that.deliverQoS(packet, done)
    })
  } else {
    that.deliverQoS(packet, done)
  }
}

Client.prototype.subscribe = function (packet, done) {
  if (!packet.subscriptions) {
    if (!Array.isArray(packet)) {
      packet = [packet]
    }
    packet = {
      subscriptions: packet
    }
  }
  handleSubscribe(this, packet, done)
}

Client.prototype.unsubscribe = function (packet, done) {
  if (!packet.unsubscriptions) {
    if (!Array.isArray(packet)) {
      packet = [packet]
    }
    packet = {
      unsubscriptions: packet
    }
  }
  handleUnsubscribe(this, packet, done)
}

Client.prototype.close = function (done) {
  var that = this
  var conn = this.conn

  if (this.connected) {
    handleUnsubscribe(
      this,
      { unsubscriptions: Object.keys(this.subscriptions) },
      finish)
  } else {
    finish()
  }

  this.parser.removeAllListeners('packet')
  conn.removeAllListeners('readable')

  if (this._keepaliveTimer) {
    this._keepaliveTimer.clear()
    this._keepaliveInterval = -1
    this._keepaliveTimer = null
  }

  if (this._connectTimer) {
    clearTimeout(this._connectTimer)
    this._connectTimer = null
  }

  this._eos()
  this._eos = nop

  function finish () {
    if (!that.disconnected && that.will) {
      that.broker.publish(that.will, that, nop)
      that.will = null // this function might be called twice
    }

    conn.removeAllListeners('error')
    conn.on('error', nop)

    if (that.broker.clients[that.id]) {
      that.broker.unregisterClient(that)
    }

    // hack to clean up the write callbacks
    // supports streams2 & streams3, so node 0.10, 0.11, and iojs
    var state = that.conn._writableState
    var list = (state.getBuffer && state.getBuffer()) || state.buffer
    list.forEach(drainRequest)

    if (conn.destroySoon) {
      conn.destroySoon()
    } if (conn.destroy) {
      conn.destroy()
    } else {
      conn.end()
    }

    if (typeof done === 'function') {
      done()
    }
  }
}

function enqueue (packet) {
  this.client._parsingBatch++
  handle(this.client, packet, this.client._nextBatch)
}

function nop () {}
