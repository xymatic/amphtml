/**
 * Copyright 2018 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {CSS} from '../../../build/amp-delight-player-0.1.css';
import {Deferred} from '../../../src/utils/promise';
import {Services} from '../../../src/services';
import {VideoAttributes, VideoEvents} from '../../../src/video-interface';
import {
  createFrameFor,
  objOrParseJson,
  originMatches,
  redispatch,
} from '../../../src/iframe-video';
import {dict} from '../../../src/utils/object';
import {getData, listen, listenOncePromise} from '../../../src/event-helper';
import {htmlFor} from '../../../src/static-template';
import {installVideoManagerForDoc} from '../../../src/service/video-manager-impl';
import {isLayoutSizeDefined} from '../../../src/layout';
import {removeElement} from '../../../src/dom';
import {setStyle} from '../../../src/style';
import {userAssert} from '../../../src/log';

/** @const */
const TAG = 'amp-delight-player';

/**
 * TODO: export this from a lower level, like 'src'
 * @private @const
 * */
const ANALYTICS_EVENT_TYPE_PREFIX = 'video-custom-';

/** @const @enum {string} */
const DelightEvent = {
  READY: 'x-dl8-to-parent-ready',
  PLAYING: 'x-dl8-to-parent-playing',
  PAUSED: 'x-dl8-to-parent-paused',
  ENDED: 'x-dl8-to-parent-ended',
  TIME_UPDATE: 'x-dl8-to-parent-timeupdate',
  DURATION: 'x-dl8-to-parent-duration',
  MUTED: 'x-dl8-to-parent-muted',
  UNMUTED: 'x-dl8-to-parent-unmuted',
  ENTERED_FULLSCREEN: 'x-dl8-to-parent-entered-fullscreen',
  EXITED_FULLSCREEN: 'x-dl8-to-parent-exited-fullscreen',
  AD_START: 'x-dl8-to-parent-amp-ad-start',
  AD_END: 'x-dl8-to-parent-amp-ad-end',
  PLAY: 'x-dl8-to-iframe-play',
  PAUSE: 'x-dl8-to-iframe-pause',
  ENTER_FULLSCREEN: 'x-dl8-to-iframe-enter-fullscreen',
  EXIT_FULLSCREEN: 'x-dl8-to-iframe-exit-fullscreen',
  MUTE: 'x-dl8-to-iframe-mute',
  UNMUTE: 'x-dl8-to-iframe-unmute',
  ENABLE_INTERFACE: 'x-dl8-to-iframe-enable-interface',
  DISABLE_INTERFACE: 'x-dl8-to-iframe-disable-interface',
  SEEK: 'x-dl8-to-iframe-seek',
  CUSTOM_TICK: 'x-dl8-to-parent-amp-custom-tick',

  PING: 'x-dl8-ping',
  PONG: 'x-dl8-pong',
  EXPANDED: 'x-dl8-iframe-enter-fullscreen',
  MINIMIZED: 'x-dl8-iframe-exit-fullscreen',
  SCREEN_CHANGE: 'x-dl8-iframe-screen-change',
  WINDOW_ORIENTATIONCHANGE: 'x-dl8-iframe-window-orientationchange',
  WINDOW_DEVICEORIENTATION: 'x-dl8-iframe-window-deviceorientation',
  WINDOW_DEVICEMOTION: 'x-dl8-iframe-window-devicemotion',
};

/** @implements {../../../src/video-interface.VideoInterface} */
class AmpDelightPlayer extends AMP.BaseElement {
  /** @param {!AmpElement} element */
  constructor(element) {
    super(element);

    /** @private {string} */
    this.baseURL_ = 'https://players.delight-vr.com';

    /** @private {string} */
    this.contentID_ = '';

    /** @private {number} */
    this.totalDuration_ = 1;

    /** @private {number} */
    this.currentTime_ = 0;

    /** @private {Array} */
    this.playedRanges_ = [];

    /** @private {boolean} */
    this.isFullscreen_ = false;

    /** @private {Element} */
    this.iframe_ = null;

    /** @private {?Promise} */
    this.playerReadyPromise_ = null;

    /** @private {?Function} */
    this.playerReadyResolver_ = null;

    /** @private {?Function} */
    this.unlistenMessage_ = null;

    /** @private {?Function} */
    this.unlistenScreenOrientationChange_ = null;

    /** @private {?Function} */
    this.unlistenOrientationChange_ = null;

    /** @private {?Function} */
    this.unlistenDeviceOrientation_ = null;

    /** @private {?Function} */
    this.unlistenDeviceMotion_ = null;

    /** @private {HTMLElement} */
    this.placeholderEl_ = null;
  }

  /**
   * @param {boolean=} onLayout
   * @override
   */
  preconnectCallback(onLayout) {
    Services.preconnectFor(this.win).url(
      this.getAmpDoc(),
      this.baseURL_,
      onLayout
    );
  }

  /** @override */
  renderOutsideViewport() {
    return false;
  }

  /** @override */
  buildCallback() {
    this.contentID_ = userAssert(
      this.element.getAttribute('data-content-id'),
      'The data-content-id attribute is required'
    );

    const deferred = new Deferred();
    this.playerReadyPromise_ = deferred.promise;
    this.playerReadyResolver_ = deferred.resolve;

    installVideoManagerForDoc(this.element);
    Services.videoManagerForDoc(this.element).register(this);
  }

  /** @override */
  layoutCallback() {
    const src = `${this.baseURL_}/player/${this.contentID_}?amp=1`;
    const iframe = createFrameFor(this, src);

    iframe.setAttribute('allow', 'vr');

    this.unlistenMessage_ = listen(this.win, 'message', event => {
      this.handleDelightMessage_(event);
    });

    this.iframe_ = iframe;

    this.registerEventHandlers_();

    return this.loadPromise(iframe);
  }

  /** @override */
  unlayoutCallback() {
    if (this.element.hasAttribute(VideoAttributes.DOCK)) {
      return false; // do nothing, do not relayout
    }

    if (this.iframe_) {
      removeElement(this.iframe_);
      this.iframe_ = null;
    }
    if (this.unlistenMessage_) {
      this.unlistenMessage_();
    }

    const deferred = new Deferred();
    this.playerReadyPromise_ = deferred.promise;
    this.playerReadyResolver_ = deferred.resolve;

    this.unregisterEventHandlers_();

    return true;
  }

  /** @override */
  isLayoutSupported(layout) {
    return isLayoutSizeDefined(layout);
  }

  /** @override */
  createPlaceholderCallback() {
    const html = htmlFor(this.element);
    const placeholder = html`
      <div placeholder><amp-img layout="fill"></amp-img></div>
    `;

    const src = `${this.baseURL_}/poster/${this.contentID_}`;

    placeholder.firstElementChild.setAttribute('src', src);

    this.placeholderEl_ = /** @type {HTMLElement} */ (placeholder);

    return placeholder;
  }

  /** @override */
  firstLayoutCompleted() {
    const el = this.placeholderEl_;
    let promise = null;
    if (el && this.isInViewport()) {
      el.classList.add('i-amphtml-delight-player-faded');
      promise = listenOncePromise(el, 'transitionend');
    } else {
      promise = Promise.resolve();
    }
    return promise.then(() => super.firstLayoutCompleted());
  }

  /** @override  */
  pauseCallback() {
    if (this.iframe_ && this.iframe_.contentWindow) {
      this.pause();
    }
  }

  /** @override */
  resumeCallback() {
    if (this.iframe_ && this.iframe_.contentWindow) {
      this.play(false);
    }
  }

  /**
   * @param {!Event} event
   * @private
   */
  handleDelightMessage_(event) {
    if (!originMatches(event, this.iframe_, /.*/)) {
      return;
    }

    const data = objOrParseJson(getData(event));
    if (!data || !data['type']) {
      return; // We only process valid JSON.
    }

    const {element} = this;

    const redispatched = redispatch(element, data['type'], {
      [DelightEvent.PLAYING]: VideoEvents.PLAYING,
      [DelightEvent.PAUSED]: VideoEvents.PAUSE,
      [DelightEvent.ENDED]: VideoEvents.ENDED,
      [DelightEvent.MUTED]: VideoEvents.MUTED,
      [DelightEvent.UNMUTED]: VideoEvents.UNMUTED,
      [DelightEvent.AD_START]: VideoEvents.AD_START,
      [DelightEvent.AD_END]: VideoEvents.AD_END,
    });

    if (redispatched) {
      return;
    }

    switch (data['type']) {
      case DelightEvent.PING: {
        const guid = data['guid'];
        if (guid) {
          this.iframe_.contentWindow./*OK*/ postMessage(
            JSON.stringify(
              /** @type {JsonObject} */ ({
                type: DelightEvent.PONG,
                guid,
                idx: 0,
              })
            ),
            '*'
          );
        }
        break;
      }
      case DelightEvent.READY: {
        element.dispatchCustomEvent(VideoEvents.LOAD);
        this.playerReadyResolver_(this.iframe_);
        break;
      }
      case DelightEvent.TIME_UPDATE: {
        const payload = data['payload'];
        this.currentTime_ = payload.currentTime;
        this.playedRanges_ = payload.playedRanges;
        break;
      }
      case DelightEvent.DURATION: {
        const payload = data['payload'];
        this.totalDuration_ = payload.duration;
        break;
      }
      case DelightEvent.EXPANDED: {
        this.setFullHeight_();
        break;
      }
      case DelightEvent.MINIMIZED: {
        this.setInlineHeight_();
        break;
      }
      case DelightEvent.ENTERED_FULLSCREEN: {
        this.isFullscreen_ = true;
        break;
      }
      case DelightEvent.EXITED_FULLSCREEN: {
        this.isFullscreen_ = false;
        break;
      }
      case DelightEvent.CUSTOM_TICK: {
        const payload = data['payload'];
        this.dispatchCustomAnalyticsEvent_(payload.type, payload);
        break;
      }
    }
  }

  /**
   * @param {string} eventType The eventType must be prefixed with video-custom- to prevent naming collisions with other analytics event types.
   * @param {!Object<string, string>=} vars
   */
  dispatchCustomAnalyticsEvent_(eventType, vars) {
    this.element.dispatchCustomEvent(
      VideoEvents.CUSTOM_TICK,
      dict({
        'eventType': ANALYTICS_EVENT_TYPE_PREFIX + eventType,
        'vars': vars,
      })
    );
  }

  /**
   * Sends a command to the player through postMessage.
   * @param {string} type
   * @param {Object=} payload
   * @private
   */
  sendCommand_(type, payload = {}) {
    this.playerReadyPromise_.then(iframe => {
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow./*OK*/ postMessage(
          JSON.stringify(/** @type {JsonObject} */ ({type, payload})),
          '*'
        );
      }
    });
  }

  /**
   * Expands the player's height in the DOM
   * @private
   */
  setFullHeight_() {
    setStyle(this.iframe_, 'position', 'fixed');
  }

  /**
   * Retracts the player's height in the DOM
   * @private
   */
  setInlineHeight_() {
    setStyle(this.iframe_, 'position', 'absolute');
  }

  /**
   * Register event handlers to pass events to iframe
   * @private
   */
  registerEventHandlers_() {
    const dispatchScreenOrientationChangeEvents = () => {
      const orientation =
        window.screen.orientation ||
        window.screen.mozOrientation ||
        window.screen.msOrientation;
      this.sendCommand_(DelightEvent.SCREEN_CHANGE, {
        orientation: {
          angle: orientation.angle,
          type: orientation.type,
        },
      });
    };
    const dispatchOrientationChangeEvents = () => {
      const {orientation} = window;
      this.sendCommand_(DelightEvent.WINDOW_ORIENTATIONCHANGE, {
        orientation,
      });
    };
    const dispatchDeviceOrientationEvents = event => {
      this.sendCommand_(DelightEvent.WINDOW_DEVICEORIENTATION, {
        alpha: event.alpha,
        beta: event.beta,
        gamma: event.gamma,
        absolute: event.absolute,
        timeStamp: event.timeStamp,
      });
    };
    const dispatchDeviceMotionEvents = event => {
      const payload = {
        interval: event.interval,
        timeStamp: event.timeStamp,
      };
      if (event.acceleration) {
        payload.acceleration.x = event.acceleration.x;
        payload.acceleration.y = event.acceleration.y;
        payload.acceleration.z = event.acceleration.z;
      }
      if (event.accelerationIncludingGravity) {
        payload.accelerationIncludingGravity.x =
          event.accelerationIncludingGravity.x;
        payload.accelerationIncludingGravity.y =
          event.accelerationIncludingGravity.y;
        payload.accelerationIncludingGravity.z =
          event.accelerationIncludingGravity.z;
      }
      if (event.rotationRate) {
        payload.rotationRate.alpha = event.rotationRate.alpha;
        payload.rotationRate.beta = event.rotationRate.beta;
        payload.rotationRate.gamma = event.rotationRate.gamma;
      }
      this.sendCommand_(DelightEvent.WINDOW_DEVICEMOTION, payload);
    };
    if (window.screen) {
      const screen =
        window.screen.orientation ||
        window.screen.mozOrientation ||
        window.screen.msOrientation;
      if (screen && screen.addEventListener) {
        this.unlistenScreenOrientationChange_ = listen(
          screen,
          'change',
          dispatchScreenOrientationChangeEvents
        );
      } else {
        this.unlistenOrientationChange_ = listen(
          this.win,
          'orientationchange',
          dispatchOrientationChangeEvents
        );
      }
    } else {
      this.unlistenOrientationChange_ = listen(
        this.win,
        'orientationchange',
        dispatchOrientationChangeEvents
      );
    }
    this.unlistenDeviceOrientation_ = listen(
      this.win,
      'deviceorientation',
      dispatchDeviceOrientationEvents
    );
    this.unlistenDeviceMotion_ = listen(
      this.win,
      'devicemotion',
      dispatchDeviceMotionEvents
    );
  }

  /**
   * Unregister event handlers that pass events to iframe
   * @private
   */
  unregisterEventHandlers_() {
    if (this.unlistenScreenOrientationChange_) {
      this.unlistenScreenOrientationChange_();
    }
    if (this.unlistenOrientationChange_) {
      this.unlistenOrientationChange_();
    }
    if (this.unlistenDeviceOrientation_) {
      this.unlistenDeviceOrientation_();
    }
    if (this.unlistenDeviceMotion_) {
      this.unlistenDeviceMotion_();
    }
  }

  // VideoInterface Implementation. See ../src/video-interface.VideoInterface

  /** @override */
  supportsPlatform() {
    return true;
  }

  /** @override */
  isInteractive() {
    return true;
  }

  /** @override */
  play(unusedIsAutoplay) {
    this.sendCommand_(DelightEvent.PLAY);
  }

  /** @override */
  pause() {
    this.sendCommand_(DelightEvent.PAUSE);
  }

  /** @override */
  mute() {
    this.sendCommand_(DelightEvent.MUTE);
  }

  /** @override */
  unmute() {
    this.sendCommand_(DelightEvent.UNMUTE);
  }

  /** @override */
  showControls() {
    this.sendCommand_(DelightEvent.ENABLE_INTERFACE);
  }

  /** @override */
  hideControls() {
    this.sendCommand_(DelightEvent.DISABLE_INTERFACE);
  }

  /**
   * @override
   */
  fullscreenEnter() {
    this.sendCommand_(DelightEvent.ENTER_FULLSCREEN);
  }

  /**
   * @override
   */
  fullscreenExit() {
    this.sendCommand_(DelightEvent.EXIT_FULLSCREEN);
  }

  /** @override */
  isFullscreen() {
    return this.isFullscreen_;
  }

  /** @override */
  getMetadata() {
    // Not implemented
  }

  /** @override */
  preimplementsMediaSessionAPI() {
    return false;
  }

  /** @override */
  preimplementsAutoFullscreen() {
    return false;
  }

  /** @override */
  getCurrentTime() {
    return this.currentTime_;
  }

  /** @override */
  getDuration() {
    return this.totalDuration_;
  }

  /** @override */
  getPlayedRanges() {
    return /** @type {!Array<Array<number>>} */ (this.playedRanges_);
  }

  /** @override */
  seekTo(time) {
    this.sendCommand_(DelightEvent.SEEK, {time});
  }
}

AMP.extension(TAG, '0.1', AMP => {
  AMP.registerElement(TAG, AmpDelightPlayer, CSS);
});
