
(function (exports) {

exports.createReceiver = createReceiver;
exports.createTransmitter = createTransmitter;
exports.enableAudioApiOnIos = enableAudioApiOnIos;

exports.canReceive = false;
exports.canTransmit = false;

var getUserMedia = ( navigator.getUserMedia ||
                     navigator.webkitGetUserMedia ||
                     navigator.mozGetUserMedia ||
                     navigator.msGetUserMedia);


var AudioContext = ( window.AudioContext ||
                     window.webkitAudioContext ||
                     window.mozAudioContext ||
                     window.msAudioContext);

var PULSE_INTERVAL = .2;
var PULSE_TIMEOUT = PULSE_INTERVAL * 20;
var FREQS = 500;

var BITS = { "8": 8, "16": 16, "32": 32 };
var MAX_NO = { "8": 0xff, "16": 0xffff, "32": 0xffffff };
var FREQUENCES = { "low": 18000, "hi": 19000 };
var THRESHOLDS = { "low": -65, "hi": -85 };

var context;


try {    
  context = new AudioContext();
  exports.canReceive = getUserMedia ? true : false;
  exports.canTransmit = true;
} catch (e) {
  exports.canReceive = false;
  exports.canTransmit = false;
}


function createReceiver (options) {
  var frequences;
  var start;
  var threshold;
  var bits;

  if (exports.canReceive == false) {
    throw new Error("Receiving is not supported on device");
  }

  options = options || {};

  start = FREQUENCES[options.frequence || "hi"];

  if (!start) {
    throw new Error("Bad frequence, expected 'low' or 'hi'");
  }

  threshold = THRESHOLDS[options.threshold || "hi"];

  if (!threshold) {
    throw new Error("Bad threshold, expected 'low' or 'hi'");
  }

  bits = BITS[options.bits || "16"];

  if (!bits) {
    throw new Error("Bad bits, expected '8', '16' or '32'");
  }

  return new Receiver(start, start + FREQS, 50, bits, threshold);
}


function createTransmitter (id, options) {
  var frequences;
  var start;
  var threshold;
  var bits;

  if (exports.canTransmit == false) {
    throw new Error("Transmitting is not supported on device");
  }

  if (typeof id !== "number") {
    throw new Error("Expected 'id' as number");
  }

  options = options || {};

  start = FREQUENCES[options.frequence || "hi"];

  if (!start) {
    throw new Error("Bad frequence, expected 'low' or 'hi'");
  }

  bits = BITS[options.bits || "16"];

  if (!bits) {
    throw new Error("Bad bits, expected '8', '16' or '32'");
  }

  if (id < 0 || id > MAX_NO[bits]) {
    throw new Error("ID out of range. Increase 'bits' to use larger IDs");
  }

  return new Transmitter(id, start, start + FREQS, bits);
}



function Receiver (startFreq, endFreq, tolerance, bits, threshold) {
  this.listening = false;

  this._startFreq = startFreq;
  this._endFreq = endFreq;
  this._tolerance = tolerance;
  this._bits = bits;
  this._threshold = threshold;

  this._analyserBuffer = null;

  this._lastFreq = 0;

  this._analyser = null;
  this._inputStream = null;
  this._mediaStream = null;
  this._scriptProcessor = null;
  this._testTimer = null;
  this._pulser = null;
}


Receiver.prototype.onstart = null;
Receiver.prototype.onprogress = null;
Receiver.prototype.ondata = null;
Receiver.prototype.onerror = null;


Receiver.prototype.start = function () {
  var self = this;

  if (this.listening) {
    throw new Error("Already listening");
  }

  this.listening = true;

  getUserMedia.call(navigator, {audio: true},
    function (stream) {
      self._mediaStreamHandler(stream);
    },
    function (evt) {
      self._raiseEvent({
        type: "error",
        message: "Unable to get user media"
      });
    }
  );
};


Receiver.prototype.disconnect = function () {
  this.listening = false;

  if (this._analyser) {
    this._analyser.disconnect();
    this._analyser = null;
  }

  if (this._inputStream) {
    this._inputStream.disconnect();
    this._inputStream = null;
  }

  if (this._mediaStream) {
    this._mediaStream.stop();
    this._mediaStream = null;
  }

  if (this._scriptProcessor) {
    this._scriptProcessor.onaudioprocess = null;
    this._scriptProcessor.disconnect();
    this._scriptProcessor = null;
  }

  if (this._testTimer) {
    clearTimeout(this._testTimer);
    this._testTimer = null;
  }

  if (this._pulser) {
    this._pulser.disconnect;
    this._pulser = null;
  }
};


Receiver.prototype._mediaStreamHandler = function(stream) {
  this._mediaStream = stream;
  this._inputStream = context.createMediaStreamSource(stream);

  this._analyser = context.createAnalyser();
  this._inputStream.connect(this._analyser);

  this._scriptProcessor = context.createScriptProcessor(256);
  this._scriptProcessor.connect(context.destination);

  this._analyser.connect(this._scriptProcessor);

  this._analyserBuffer = new Float32Array(this._analyser.frequencyBinCount);

  this._startFrequenceTester();
};


Receiver.prototype._startFrequenceTester = function () {
  var self = this;

  this._testTimer = setTimeout(function () {
    self._raiseEvent({
      type: "error",
      message: "Device do not support frequence range"
    });
  }, 1500);

  this._pulser = new Pulser(context);
  this._pulser.send(this._endFreq);

  this._scriptProcessor.onaudioprocess = function (event) {
    if (!(self._getCurrentFrequence())) {
      return;
    }

    clearTimeout(self._testTimer);
    self._pulser.disconnect();
    self._pulser = null;
    self._startPulseProcessor();
  };
};


Receiver.prototype._startPulseProcessor = function () {
  var self = this;
  var statePos = 0;
  var stateValue = NaN;
  var stateLast = -1;
  var range;
  var start;
  var bits;

  self._raiseEvent({
    type: "start"
  });

  range = this._endFreq - this._startFreq;
  start = this._startFreq;
  bits = this._bits;

  function reset () {
    statePos = 0;
    stateValue = NaN;
    stateLast = -1;

    self._raiseEvent({
      type: "progress",
      received: statePos,
      total: bits
    });
  }

  this._scriptProcessor.onaudioprocess = function (event) {
    var freq;
    var flag;

    freq = self._getCurrentFrequence();

    if (!freq) {
      if (self._lastFreq &&
          self._lastFreq + PULSE_TIMEOUT < context.currentTime) {
        self._lastFreq = 0;
        reset();
        self._raiseEvent({
          type: "leave"
        });
      }
      // console.log("noe freq: %s", (context.sampleRate / 2) / len * idx);
      return;
    }

    if (self._lastFreq == 0) {
      self._raiseEvent({
        type: "enter"
      });
    }

    self._lastFreq = context.currentTime;

    flag = Math.round(5 * ((freq - start) / range));

    switch (true) {

    case flag == 0:
      console.log("Header received %s", freq);
      statePos = 0;
      stateValue = 0;
      stateLast = 0;
      return;

    case isNaN(stateValue):
      // console.log("Skip puls %s, no header received %s", flag, freq);
      return;

    case flag == stateLast:
      // console.log("Skip puls, same %s %s", flag, stateLast);
      return;

    case ((statePos % 2) == 0 && flag > 2 ||
          (statePos % 2) && flag < 3):
      console.log("Bad flag %s %s %s", statePos, flag, freq);
      reset();
      return;
    }
    console.log("in: %s, pos %s", flag, statePos);
    stateLast = flag;

    self._raiseEvent({
      type: "progress",
      received: statePos,
      total: bits
    });

    if (flag == 2 || flag == 4) {
      stateValue = stateValue | (1 << statePos);
    } else {
      stateValue = stateValue & ~(1 << statePos);
    }

    statePos++;

    if (statePos == bits) {
      self._raiseEvent({
        type: "data",
        data: stateValue
      });
      statePos = 0;
      stateValue = NaN;
    }
  };
};


Receiver.prototype._getCurrentFrequence = function () {
  var max;
  var idx;
  var len;
  var freq;
  var buffer;

  buffer = this._analyserBuffer;
  this._analyser.getFloatFrequencyData(buffer);

  max = -Infinity;
  idx = -1;
  len = buffer.length;

  for (var i = 0; i < len; i++) {
    if (buffer[i] > max) {
      max = buffer[i];
      idx = i;
    }
  }

  // if (max < this._threshold) {
  //   return;
  // }

  freq = (context.sampleRate / 2) / len * idx;

  if (freq > this._startFreq && freq < this._endFreq) {
    return freq;
  }

  if (this._endFreq - freq < this._tolerance) {
    return this._endFreq;
  }

  if (this._startFreq - freq < this._tolerance) {
    return this._startFreq;
  }
};


Receiver.prototype._raiseEvent = function (evt) {
  var handler;

  if (evt.type == "error") {
    this.disconnect();
  }

  handler = "on" + evt.type;

  if (typeof this[handler] == "function") {
    this[handler](evt)
  }
};


function Transmitter (id, startFreq, endFreq, bits) {
  this.transmitting = false;
  this.id = id;
  this._startFreq = startFreq;
  this._endFreq = endFreq;
  this._bits = bits;
  this._pulser = null;
  this._timer = null;
}


Transmitter.prototype.start = function () {
  var self = this;
  var useragent;

  if (this.transmitting) {
    throw new Error("Already transmitting");
  }

  this.transmitting = true;  

  this._startLoop();
};

Transmitter.prototype._startLoop = function () {
  var pulser;
  var id;
  var startFreq;
  var endFreq;
  var bits;

  id = this.id;
  startFreq = this._startFreq;
  endFreq = this._endFreq;
  bits = this._bits;

  pulser = new Pulser(context);

  this._pulser = pulser;

  this._timer = setInterval(function () {
    pulser.sendSequence(id, startFreq, endFreq, bits);
  }, ((bits + 1) * PULSE_INTERVAL) * 1000);

  pulser.sendSequence(id, startFreq, endFreq, bits);
}


Transmitter.prototype.disconnect = function () {

  this.transmitting = false;

  if (this._timer) {
    clearInterval(this._timer);
    this._timer = null;
  }

  if (this._pulser) {
    this._pulser.disconnect();
    this._pulser = null;
  }
};


function Pulser (context) {
  this._context = context;

  if ("createGainNode" in context) {
    this._gain = context.createGainNode();
  } else {
    this._gain = context.createGain();
  }

  this._gain.gain.value = 0;
  this._gain.connect(context.destination);

  this._osc = context.createOscillator();
  this._osc.frequency.value = 0;
  this._osc.connect(this._gain);
  this._osc.start(context.currentTime);

  this._time = 0;
}


Pulser.prototype.send = function (freq) {
  var time;

  time = this._time > this._context.currentTime ? this._time
                                                : this._context.currentTime;

  this._gain.gain.setValueAtTime(1, time);
  this._gain.gain.setValueAtTime(0, time + PULSE_INTERVAL);
  this._osc.frequency.setValueAtTime(freq, time);

  this._time = time + PULSE_INTERVAL;
};

Pulser.prototype.sendSequence = function (val, start, end, bits) {
  var time;
  var freq;
  var idx;
  var range;

  this.send(start);

  range = end - start;

  for (var b = 0; b < bits; b++) {

    idx = b % 2 == 0 ? 1 : 3;

    idx += (val & (1 << b)) ? 1 : 0;

    freq = start + Math.round(range * (idx / 5));

    this.send(freq);
  }
};


Pulser.prototype.disconnect = function () {
  if (this._gain) {
    this._gain.disconnect();
    this._gain = null;
  }

  if (this._osc) {
    this._osc.disconnect();
    this._osc = null;
  }

  this._context = null;
};


function enableAudioApiOnIos () {
  var useragent = navigator.userAgent;
  if (useragent.indexOf('iPhone') != -1 || useragent.indexOf('iPod') != -1) {
    window.addEventListener("touchstart", function () {
      var buffer = context.createBufferSource();
      buffer.noteOn(0);
    });
  }  
}

}((window.airpair = {})));