import { isDebugMode } from '~/util';
import { Worker } from './worker';
import Logger from '~/util/logger';

import * as blazeface from '@tensorflow-models/blazeface';
import * as handpose from '@tensorflow-models/handpose';
import * as tf from '@tensorflow/tfjs-core';
// import * as tfjsWebgl from '@tensorflow/tfjs-backend-webgl';
import * as tfjsWasm from '@tensorflow/tfjs-backend-wasm';
import sunglassSource from '../images/sunglass.png';
import santaSource from '../images/santa_new.png';
import sooSource from '../images/soo.png';
import chelseaSource from '../images/chelsea-hat.png';
import mancitySource from '../images/mancity.png';
import realmadridSource from '../images/realmadrid.png';

import CodecHelper from '~/util/codec-helper';

const logger = new Logger('gum.js');

export class GUMWorker extends Worker {
  constructor() {
    super();

    this.mediaStream = null;
    this.sunglass = null;
    this.enableEffect = false;
    this.reqId = null;
    this.effect = {
      targetNumber: 'single',
      focusPriority: 'nearest'
    };
    this.zoomStats = {
      startX: null,
      startY: null,
      sizeX: null,
      sizeY: null
    };
    this.initNum = 0;
    this.initSizeX = 0;
    this.initSizeY = 0;
    this.initRatioX = 0;
    this.initRatioY = 0;
    this.frameRate = 30;
    this.video = document.getElementsByTagName('video')[0];
    this.canvas = document.getElementsByTagName('canvas')[0];
    this.video.addEventListener('loadedmetadata', () => {
      this.canvas.setAttribute('width', this.video.videoWidth);
      this.canvas.setAttribute('height', this.video.videoHeight);
      this.video.setAttribute('muted', '');
      this.video.setAttribute('playsinline', '');
      this.video.style.position = 'absolute';
      this.canvas.style.position = 'absolute';

      this.originStream = this.mediaStream;
      this.canvasStream = this.canvas.captureStream();
      this.canvasTrack = this.canvasStream.getVideoTracks()[0];

      if (this.enableEffect) {
        const videoTrack = this.mediaStream.getVideoTracks()[0];
        const sender = this.peerConnection.getSenders().find(s => {
          return s.track.kind === videoTrack.kind;
        });
        sender.replaceTrack(this.canvasTrack);
      }
    });
    this.videoPlayListener = null;
    this.context = this.canvas.getContext('2d', {
      desynchronized: true,
      alpha: false
    });
  }

  onConnected(url) {
    logger.debug('onConnected() ' + url);
    try {
      tfjsWasm.setWasmPaths(url + '/');
      tf.setBackend('wasm');
      tf.ready().then(() => {
        handpose.load().then(model => {
          this.handModel = model;
        });
        blazeface.load().then(model => {
          this.model = model;
        });
      });
    } catch (e) {
      logger.error('setbackend(wasm) failed. ' + e);
    }
  }

  checkCapability() {
    logger.debug('checkCapability');

    if (typeof android !== 'undefined') {
      // On android webview, H264 is missed at the beginning of loading.
      // It causes the leak of H264 from the sdp of the offer.
      // Calling RTCRtpSender.getCapabilities here can be a solution to include
      // H264 in the sdp. But, it seems to be a bit of trick.
      alert(RTCRtpSender.getCapabilities('video'));
    }
    return new Promise((resolve, reject) => {
      navigator.mediaDevices
        .enumerateDevices()
        .then(devices => {
          devices.forEach(device => {
            if (device.kind === 'videoinput') {
              this.features.add('CAMERA');
            }
            if (device.kind === 'audioinput') {
              this.features.add('MIC');
            }
          });

          resolve(this.features);
        })
        .catch(err => {
          logger.error('err.code: ' + err.code);
          logger.error(err.name + ': ' + err.message);
          reject(this.features);
        });
    }).catch(err => {
      // Return the empty features if getting reject promise
      return this.features;
    });
  }

  handleMessage(message) {
    if (message.type === 'start') {
      this.requestConfirmation(
        message.feature,
        message.clientId,
        message.deviceName
      ).then(allowed => {
        if (allowed) {
          this.startGum(message.arguments[0], message.feature);
        } else {
          this.dataChannel.send(
            JSON.stringify({
              type: 'error',
              feature: message.feature,
              error: {
                message: 'Permission denied',
                name: 'NotAllowedError'
              }
            })
          );
        }
      });
    } else if (message.type === 'applyConstraints') {
      this.applyConstraints(message.constraints, message.feature);
    } else if (message.type === 'stopTrack') {
      const transceiver = this.peerConnection.getTransceivers().find(t => {
        return t.sender && t.sender.track.id === message.trackId;
      });
      if (transceiver && transceiver.sender) {
        transceiver.sender.track.stop();
        transceiver.stop();
        this.peerConnection.removeTrack(transceiver.sender);
      } else {
        logger.log('Failed to stopTrack() ' + message.trackId);
      }
    }
  }

  minimumRatio = 10;

  passesMinimumRatio(before, after) {
    return (100 * Math.abs(before - after)) / before > this.minimumRatio;
  }

  runPrediction() {
    if (!this.enableEffect) {
      this.context.drawImage(this.video, 0, 0);
    } else {
      this.model
        .estimateFaces(this.video, false, false, true)
        .then(predictions => {
          if (predictions.length > 0) {
            let faceIndex = 0;
            if (this.effect.focusPriority === 'farthest') {
              faceIndex = predictions.length - 1;
            } else if (this.effect.focusPriority === 'median') {
              faceIndex = predictions.length / 2;
            }

            const validPredictions = predictions.filter(prediction => {
              return prediction.probability >= 0.8;
            });

            if (!validPredictions.length) {
              return;
            }

            const prediction = validPredictions[faceIndex];

            let start = [0, 0];
            let end = [0, 0];
            let size = [0, 0];

            if (
              this.effect.targetNumber === 'group' &&
              validPredictions.length > 1
            ) {
              const startX = Math.min.apply(
                null,
                validPredictions.map(prediction => prediction.topLeft[0])
              );
              const startY = Math.min.apply(
                null,
                validPredictions.map(prediction => prediction.topLeft[1])
              );
              const endX = Math.max.apply(
                null,
                validPredictions.map(prediction => prediction.bottomRight[0])
              );
              const endY = Math.max.apply(
                null,
                validPredictions.map(prediction => prediction.bottomRight[1])
              );
              start = [startX, startY];
              end = [endX, endY];
              size = [endX - startX, endY - startY];
            } else {
              start = prediction.topLeft;
              end = prediction.bottomRight;
              size = [end[0] - start[0], end[1] - start[1]];
            }

            const startX = Math.min(
              Math.max(start[0] - 100, 0),
              this.video.videoWidth - size[0] - 200
            );
            const startY = Math.min(
              Math.max(start[1] - 100, 0),
              this.video.videoHeight - size[1] - 200
            );

            const sizeX = size[0];
            const sizeY = size[1];

            if (
              isNaN(this.zoomStats.sizeX) ||
              isNaN(this.zoomStats.sizeY) ||
              isNaN(this.zoomStats.startX) ||
              isNaN(this.zoomStats.startY)
            ) {
              this.zoomStats.startX = startX;
              this.zoomStats.startY = startY;
              this.zoomStats.sizeX = sizeX;
              this.zoomStats.sizeY = sizeY;
              return;
            }

            if (
              this.passesMinimumRatio(this.zoomStats.startX, startX) ||
              this.passesMinimumRatio(this.zoomStats.startY, startY) ||
              this.passesMinimumRatio(this.zoomStats.sizeX, size[0]) ||
              this.passesMinimumRatio(this.zoomStats.sizeY, size[1])
            ) {
              this.zoomStats.startX = startX;
              this.zoomStats.startY = startY;
              this.zoomStats.sizeX = sizeX;
              this.zoomStats.sizeY = sizeY;
            }

            // 애니메이션 이펙트 변수 세팅
            if (this.initSizeX === 0) {
              this.initSizeX = this.video.videoWidth - sizeX;
              if (this.initRatioX === 0) {
                this.initRatioX = this.initSizeX / 50;
              }
            }
            if (this.initSizeY === 0) {
              this.initSizeY = this.video.videoHeight - sizeY;
              if (this.initRatioY === 0) {
                this.initRatioY = this.initSizeY / 50;
              }
            }

            this.context.drawImage(
              this.video,
              Math.floor(this.zoomStats.startX),
              Math.floor(this.zoomStats.startY),
              Math.floor(
                this.initNum < 50
                  ? this.zoomStats.sizeX +
                      this.initSizeX -
                      this.initNum * this.initRatioX +
                      200
                  : this.zoomStats.sizeX + 200
              ),
              Math.floor(
                this.initNum < 50
                  ? this.zoomStats.sizeY +
                      this.initSizeY -
                      this.initNum * this.initRatioY +
                      200
                  : this.zoomStats.sizeY + 200
              ),
              0,
              0,
              this.video.videoWidth,
              this.video.videoHeight
            );

            if (this.initNum < 50) {
              this.initNum++;
            }
          }
        });
    }

    this.reqId = requestAnimationFrame(this.runPrediction.bind(this));
  }

  runDrawGlasses() {
    this.context.drawImage(this.video, 0, 0);
    this.model
      .estimateFaces(this.video, false, false, true)
      .then(predictions => {
        if (predictions.length > 0) {
          const prediction = predictions[0];
          if (prediction.probability < 0.8) {
            return;
          }

          const landmarks = prediction.landmarks;
          const rightEyeX = parseInt(landmarks[0][0]);
          const rightEyeY = parseInt(landmarks[0][1]);

          const start = prediction.topLeft;
          const end = prediction.bottomRight;
          const size = [end[0] - start[0], end[1] - start[1]];

          if (this.enableEffect && this.sunglass) {
            this.context.drawImage(
              this.sunglass,
              rightEyeX - size[0] / 4,
              rightEyeY - size[1] / 2,
              size[0],
              size[1]
            );
          }
        }
      });

    this.reqId = requestAnimationFrame(this.runDrawGlasses.bind(this));
  }

  runDrawSanta() {
    this.context.drawImage(this.video, 0, 0);
    this.model
      .estimateFaces(this.video, false, false, true)
      .then(predictions => {
        if (predictions.length > 0) {
          const prediction = predictions[0];
          if (prediction.probability < 0.8) {
            return;
          }

          const start = prediction.topLeft;
          const end = prediction.bottomRight;
          const size = [end[0] - start[0], end[1] - start[1]];

          if (this.enableEffect && this.santa) {
            this.context.drawImage(
              this.santa,
              start[0],
              start[1],
              size[0],
              size[1]
            );
          }
        }
      });

    this.reqId = requestAnimationFrame(this.runDrawSanta.bind(this));
  }

  runDrawSoo() {
    this.context.drawImage(this.video, 0, 0);
    this.model
      .estimateFaces(this.video, false, false, true)
      .then(predictions => {
        if (predictions.length > 0) {
          const prediction = predictions[0];
          if (prediction.probability < 0.8) {
            return;
          }

          const landmarks = prediction.landmarks;
          const rightEyeX = parseInt(landmarks[0][0]);
          const rightEyeY = parseInt(landmarks[0][1]);

          const start = prediction.topLeft;
          const end = prediction.bottomRight;
          const size = [end[0] - start[0], end[1] - start[1]];

          if (this.enableEffect && this.soo) {
            this.context.drawImage(
              this.soo,
              rightEyeX - size[0] / 2,
              rightEyeY - size[1] / 2,
              size[0] * 1.5,
              size[1] * 1.5
            );
          }
        }
      });

    this.reqId = requestAnimationFrame(this.runDrawSoo.bind(this));
  }

  runDrawMancity() {
    this.context.drawImage(this.video, 0, 0);
    this.model
      .estimateFaces(this.video, false, false, true)
      .then(predictions => {
        for (const prediction of predictions) {
          if (prediction.probability[0] < 0.8) {
            return;
          }

          const landmarks = prediction.landmarks;
          const rightEyeX = parseInt(landmarks[0][0]);
          const rightEyeY = parseInt(landmarks[0][1]);

          const start = prediction.topLeft;
          const end = prediction.bottomRight;
          const size = [end[0] - start[0], end[1] - start[1]];

          if (this.enableEffect && this.mancity) {
            this.context.drawImage(
              this.mancity,
              rightEyeX - size[0] / 1.3,
              rightEyeY - size[1] * 1.5,
              size[0] * 2,
              size[1] * 2
            );
          }
        }
      });

    this.reqId = requestAnimationFrame(this.runDrawMancity.bind(this));
  }

  runDrawMadrid() {
    this.context.drawImage(this.video, 0, 0);
    this.model
      .estimateFaces(this.video, false, false, true)
      .then(predictions => {
        for (const prediction of predictions) {
          if (prediction.probability[0] < 0.8) {
            return;
          }

          const landmarks = prediction.landmarks;
          const rightEyeX = parseInt(landmarks[0][0]);
          const rightEyeY = parseInt(landmarks[0][1]);

          const start = prediction.topLeft;
          const end = prediction.bottomRight;
          const size = [end[0] - start[0], end[1] - start[1]];

          if (this.enableEffect && this.madrid) {
            this.context.drawImage(
              this.madrid,
              rightEyeX - size[0] / 1.3,
              rightEyeY - size[1] * 1.7,
              size[0] * 2,
              size[1] * 2
            );
          }
        }
      });

    this.reqId = requestAnimationFrame(this.runDrawMadrid.bind(this));
  }

  runNone() {
    this.context.drawImage(this.video, 0, 0);
    this.reqId = requestAnimationFrame(this.runNone.bind(this));
  }

  runDrawChelsea() {
    this.context.drawImage(this.video, 0, 0);
    this.model
      .estimateFaces(this.video, false, false, true)
      .then(predictions => {
        for (const prediction of predictions) {
          if (prediction.probability[0] < 0.8) {
            return;
          }

          const landmarks = prediction.landmarks;
          const rightEyeX = parseInt(landmarks[0][0]);
          const rightEyeY = parseInt(landmarks[0][1]);

          const start = prediction.topLeft;
          const end = prediction.bottomRight;
          const size = [end[0] - start[0], end[1] - start[1]];

          if (this.enableEffect && this.chelsea) {
            this.context.drawImage(
              this.chelsea,
              rightEyeX - size[0] / 2,
              rightEyeY - size[1] * 1.5,
              size[0] * 1.5,
              size[1] * 1.5
            );
          }
        }
      });

    this.reqId = requestAnimationFrame(this.runDrawChelsea.bind(this));
  }

  drawHandPoint(ctx, y, x, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fill();
  }

  drawFingerPath(ctx, points, closePath) {
    const region = new Path2D();
    region.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
      const point = points[i];
      region.lineTo(point[0], point[1]);
    }

    if (closePath) {
      region.closePath();
    }
    ctx.stroke(region);
  }

  runHandZoom() {
    this.context.drawImage(this.video, 0, 0);
    this.handModel.estimateHands(this.video).then(predictions => {
      if (predictions.length > 0) {
        const prediction = predictions[0];
        if (prediction.handInViewConfidence < 0.8) {
          return;
        }
        const start = prediction.boundingBox.topLeft;
        const end = prediction.boundingBox.bottomRight;
        const size = [end[0] - start[0], end[1] - start[1]];

        const startX = Math.min(
          Math.max(start[0] - 100, 0),
          this.video.videoWidth - size[0] - 200
        );
        const startY = Math.min(
          Math.max(start[1] - 100, 0),
          this.video.videoHeight - size[1] - 200
        );

        if (!this.enableEffect) {
          this.context.drawImage(this.video, 0, 0);
        } else {
          this.context.drawImage(
            this.video,
            startX,
            startY,
            size[0] + 200,
            size[1] + 200,
            0,
            0,
            this.video.videoWidth,
            this.video.videoHeight
          );
        }
      }
    });

    this.reqId = requestAnimationFrame(this.runHandZoom.bind(this));
  }

  applyAIZoom() {
    // 애니메이션 변수 초기화
    this.initNum = 0;
    this.initRatioX = 0;
    this.initRatioY = 0;
    this.initSizeX = 0;
    this.initSizeY = 0;
    this.videoPlayListener = () => this.runPrediction();
    this.video.addEventListener('play', this.videoPlayListener);

    this.video.srcObject = this.mediaStream;
  }

  applyAIEmoji() {
    this.videoPlayListener = () => this.runDrawGlasses();
    this.video.addEventListener('play', this.videoPlayListener);

    this.video.srcObject = this.mediaStream;
  }

  applyAISanta() {
    this.videoPlayListener = () => this.runDrawSanta();
    this.video.addEventListener('play', this.videoPlayListener);

    this.video.srcObject = this.mediaStream;
  }

  applyAISoo() {
    this.videoPlayListener = () => this.runDrawSoo();
    this.video.addEventListener('play', this.videoPlayListener);

    this.video.srcObject = this.mediaStream;
  }

  applyAIEffect(name) {
    logger.debug('applyAIEffect:' + name);

    this.videoPlayListener = () => {
      if (name === 'mancity') {
        this.runDrawMancity();
      } else if (name === 'chelsea') {
        this.runDrawChelsea();
      } else if (name === 'madrid') {
        this.runDrawMadrid();
      }
    };

    this.video.addEventListener('play', this.videoPlayListener);
    this.video.srcObject = this.mediaStream;
  }

  applyNone() {
    this.enableEffect = false;
    this.videoPlayListener = () => this.runNone();
    this.video.addEventListener('play', this.videoPlayListener);
    this.video.srcObject = this.mediaStream;
  }

  applyHandZoom() {
    this.videoPlayListener = () => this.runHandZoom();
    this.video.addEventListener('play', this.videoPlayListener);

    this.video.srcObject = this.mediaStream;
  }

  setPreferredCodecs(track, codecs) {
    const transceiver = this.peerConnection.getTransceivers().find(t => {
      return t.sender && t.sender.track === track;
    });
    if (transceiver) {
      codecs = CodecHelper.getPreferredCodecs(codecs);
      transceiver.direction = 'sendonly';
      transceiver.setCodecPreferences(codecs);
    } else {
      logger.warn("Can't find transceiver for " + track.label);
      logger.debug(JSON.stringify(track));
    }
  }

  getStream(stream, reqConstraints, feature) {
    logger.debug(`getStream feature:${feature} ${stream.id}`);
    for (const track of stream.getTracks()) {
      if (track.kind === 'video') {
        this.frameRate = track.getSettings().frameRate;
        logger.info(
          `[Track:video]` +
            ` ${track.label}` +
            `, size:${track.getSettings().width}x${
              track.getSettings().height
            }` +
            `, frameRate:${track.getSettings().frameRate}`
        );
      } else {
        console.info(`[Track:${track.kind}] id:${track.id}`);
      }
      logger.debug(`track:${JSON.stringify(track)}`);
      logger.debug(`settings:${JSON.stringify(track.getSettings())}`);
      logger.debug(`constraints:${JSON.stringify(track.getConstraints())}`);
      logger.debug(`capabilities:${JSON.stringify(track.getCapabilities())}`);
    }
    this.mediaStream = stream;

    stream.peerConnection = this.peerConnection;
    stream.onaddtrack = event =>
      logger.debug('onaddtrack' + JSON.stringify(event));
    stream.onremovetrack = event =>
      logger.debug('onremovetrack' + JSON.stringify(event));
    stream.onactive = event => logger.debug('onactive' + JSON.stringify(event));
    stream.oninactive = event =>
      logger.debug('oninactive' + JSON.stringify(event));

    stream.getTracks().forEach(track => {
      this.peerConnection.addTrack(track, stream);
    });

    // Apply offload.videoCodecs constraint
    if (reqConstraints.offload && reqConstraints.offload.videoCodecs) {
      this.setPreferredCodecs(
        stream.getVideoTracks()[0],
        reqConstraints.offload.videoCodecs
      );
    }

    // TODO: Currently, only 1 video track is required by demo scenario.
    // Need to support audio and other tracks.
    if (feature === 'CAMERA') {
      const mediaTrack = stream.getVideoTracks()[0];

      if (typeof mediaTrack.getCapabilities === 'undefined') {
        if (typeof mediaTrack.getConstraints !== 'undefined') {
          mediaTrack.getCapabilities = mediaTrack.getConstraints;
        } else {
          throw new Error('getCapabilities is not supported');
        }
      }

      this.dataChannel.send(
        JSON.stringify({
          type: 'data',
          feature: feature,
          data: {
            capabilities: mediaTrack.getCapabilities(),
            settings: mediaTrack.getSettings(),
            constraints: mediaTrack.getConstraints()
          }
        })
      );
    }

    offloadWorker.impl.emit('stream', stream);
  }

  startGum(constraints, feature) {
    logger.debug(
      `startGum constraints:${JSON.stringify(constraints)} feature:${feature}`
    );
    const self = this;

    if (isDebugMode()) {
      navigator.mediaDevices
        .getDisplayMedia({ video: true })
        .then(stream => this.getStream(stream, constraints, feature))
        .catch(error => {
          logger.error('error: ' + error);
        });
      return;
    }

    navigator.mediaDevices
      .getUserMedia(constraints)
      .then(stream => this.getStream(stream, constraints, feature))
      .catch(error => {
        logger.error('error: ' + error);
        self.dataChannel.send(
          JSON.stringify({
            type: 'error',
            feature: feature,
            error: {
              message: error.message,
              name: error.name
            }
          })
        );
      });
  }

  applyConstraints(constraints, feature) {
    logger.debug(
      `applyConstraints ${JSON.stringify(constraints)} feature:${feature}`
    );

    if (this.reqId) {
      cancelAnimationFrame(this.reqId);
      this.reqId = null;
    }

    this.santa = null;
    this.sunglass = null;
    this.soo = null;
    this.mancity = null;
    this.chelsea = null;
    this.madrid = null;

    if (this.videoPlayListener) {
      this.video.removeEventListener('play', this.videoPlayListener);
    }
    this.videoPlayListener = null;

    if (typeof constraints.off !== 'undefined') {
      this.enableEffect = false;
    } else {
      if (constraints.tizenAiAutoZoomTarget) {
        if (constraints.tizenAiAutoZoomTarget.exact === 'none') {
          this.applyNone();
        } else {
          if (
            constraints.tizenAiAutoZoomTargetNumber &&
            constraints.tizenAiAutoZoomTargetNumber.exact
          ) {
            this.effect.targetNumber =
              constraints.tizenAiAutoZoomTargetNumber.exact;
          }
          if (
            constraints.tizenAiAutoZoomFocusPriority &&
            constraints.tizenAiAutoZoomFocusPriority.exact
          ) {
            this.effect.focusPriority =
              constraints.tizenAiAutoZoomFocusPriority.exact;
          }

          this.enableEffect = true;
          if (constraints.tizenAiAutoZoomTarget.exact === 'body') {
            this.applyHandZoom();
          } else {
            this.applyAIZoom();
          }
        }
      } else {
        if (typeof constraints.santa !== 'undefined') {
          const image = new Image();
          image.src = santaSource;
          this.santa = image;

          this.enableEffect = true;
          this.applyAISanta();
        } else if (typeof constraints.emoji !== 'undefined') {
          const image = new Image();
          image.src = sunglassSource;
          this.sunglass = image;

          this.enableEffect = true;
          this.applyAIEmoji();
        } else if (typeof constraints.soo !== 'undefined') {
          const image = new Image();
          image.src = sooSource;
          this.soo = image;

          this.enableEffect = true;
          this.applyAISoo();
        } else if (typeof constraints.mancity !== 'undefined') {
          const image = new Image();
          image.src = mancitySource;
          this.mancity = image;

          this.enableEffect = true;
          this.applyAIEffect('mancity');
        } else if (typeof constraints.madrid !== 'undefined') {
          const image = new Image();
          image.src = realmadridSource;
          this.madrid = image;

          this.enableEffect = true;
          this.applyAIEffect('madrid');
        } else if (typeof constraints.chelsea !== 'undefined') {
          const image = new Image();
          image.src = chelseaSource;
          this.chelsea = image;

          this.enableEffect = true;
          this.applyAIEffect('chelsea');
        } else {
          this.applyNone();
        }
      }
    }

    const mediaTrack = this.mediaStream.getVideoTracks()[0];
    mediaTrack
      .applyConstraints(constraints)
      .then(() => {
        this.dataChannel.send(
          JSON.stringify({
            type: 'applyConstraints',
            feature: feature,
            result: 'success',
            data: {
              settings: mediaTrack.getSettings(),
              constraints: mediaTrack.getConstraints()
            }
          })
        );
      })
      .catch(error => {
        this.dataChannel.send(
          JSON.stringify({
            type: 'applyConstraints',
            feature: feature,
            result: 'error',
            error: {
              message: error.message,
              name: error.name
            }
          })
        );
      });
  }
}
