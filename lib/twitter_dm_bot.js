'use strict';

const _unescape = require('lodash').unescape;
const express = require('express');
const bodyParser = require('body-parser');
const BaseBot = require('botmaster').BaseBot;
const Twit = require('twit');
const crypto = require('crypto');
const util = require('util');

class TwitterDMBot extends BaseBot {

  constructor(settings) {
    super(settings);
    this.type = 'twitter-dm';
    this.requiresWebhook = true;
    this.requiredCredentials = ['consumerKey', 'consumerSecret',
      'accessToken', 'accessTokenSecret', 'ownerId'];
    this.receives = {
      text: true,
      attachment: {
        audio: false,
        file: false,
        image: false,
        video: false,
        location: false,
        fallback: false,
      },
      echo: false,
      read: false,
      delivery: false,
      postback: false,
      quickReply: false,
    };

    this.sends = {
      text: true,
      quickReply: true,
      locationQuickReply: false,
      senderAction: {
        typingOn: false,
        typingOff: false,
        markSeen: false,
      },
      attachment: {
        audio: false,
        file: false,
        image: false,
        video: false,
      },
    };

    this.retrievesUserInfo = false;
    this.__applySettings(settings);
    this.__createMountPoints();
    this.__setupTwit();
  }

  /**
   * sets up the app.
   * Adds an express Router to the mount point "/twitter-dm".
   * sub Router contains code for post and get for webhook.
   */
  __createMountPoints() {
    this.app = express();
    this.requestListener = this.app;
    // for parsing application/json
    this.app.use(bodyParser.json());
    // for parsing application/x-www-form-urlencoded
    this.app.use(bodyParser.urlencoded({ extended: true }));

    /*
      twitter webhook - for registering the webhook
      twitter will also call this url every hour for verification
    */
    this.app.get('*', (req, res) => {
      /*
        1. get the crc from twitter response
        2. encrypt it with the consumer secret key and sha256 algorithm
        3. return the digested string to twitter to confirm the webhook
      */
      const hmac = crypto.createHmac('sha256', this.credentials.consumerSecret);
      hmac.update(req.query.crc_token);
      const hash = hmac.digest('base64');
      res.json({
        response_token: `sha256=${hash}`,
      });
    });

    // get the direct messages from twitter webhook via post method
    this.app.post('*', (req, res) => {
      if (req.body.direct_message_events) {
        const eventData = req.body.direct_message_events[0];
        if (this.credentials.ownerId !== eventData.message_create.sender_id) {
          this.__formatUpdate(req.body)
          .then((update) => {
            this.__emitUpdate(update);
          })
          .catch((err) => {
            err.message = `Error in __formatUpdate "${err.message}". Please report this.`;
            this.emit('error', err);
          });
        }
      }

      // just letting twitter know we got the update
      res.sendStatus(200);
    });
  }

  // setup the twit client for apis
  __setupTwit() {
    const twitCredentials = {
      consumer_key: this.credentials.consumerKey,
      consumer_secret: this.credentials.consumerSecret,
      access_token: this.credentials.accessToken,
      access_token_secret: this.credentials.accessTokenSecret,
    };
    const twit = new Twit(twitCredentials);
    this.idStr = this.credentials.accessToken.split('-')[0];
    this.id = this.idStr;
    this.twit = twit;
  }

  // incoming part
  // format the callback data, so botmaster can understand it
  __formatUpdate(rawUpdate) {
    const eventData = rawUpdate.direct_message_events[0];
    const promise = new Promise((resolve) => {
      const dateSentAt = new Date(parseInt(eventData.created_timestamp, 10));

      const formattedUpdate = {
        raw: rawUpdate,
        sender: {
          id: eventData.message_create.sender_id,
        },
        recipient: {
          id: rawUpdate.for_user_id,
        },
        timestamp: dateSentAt.getTime(),
        message: {
          mid: eventData.id,
          seq: null,
        },
      };

      const text = this.__formatIncomingText(rawUpdate);

      if (text) {
        formattedUpdate.message.text = text;
      }

      resolve(formattedUpdate);
    });

    return promise;
  }

  __formatIncomingText(rawUpdate) {
    const eventData = rawUpdate.direct_message_events[0];
    if (eventData.message_create.message_data.text !== '') {
      const text = _unescape(eventData.message_create.message_data.text);
      return text;
    }
    return null;
  }


  // outgoing part
  __formatOutgoingMessage(message) {
    console.log('-----');
    console.log(util.inspect(message, false, null));
    console.log('-----');

    let formattedMessage = {
      event: {
        type: 'message_create',
        message_create: {
          target: {
            recipient_id: message.recipient.id,
          },
          message_data: {},
        },
      },
    };

    if (message.message.text) {
      formattedMessage.event.message_create.message_data.text = message.message.text;
    } if (message.message.quick_replies) {
      const options = [];
      for (const opt of message.message.quick_replies) {
        options.push({
          label: opt.title,
          metadata: opt.payload,
        });
      }

      const quickReplyObject = {
        type: 'options',
        options,
      };
      formattedMessage.event.message_create.message_data.quick_reply = quickReplyObject;
    }

    return formattedMessage;
  }

  __sendMessage(rawMessage) {
    /*
      direct_messages/events/new: to send quick replies
      direct_messages/new: to send normal direct message
    */

    const sendMessageUrl = 'direct_messages/events/new';
    return new Promise((resolve, reject) => {
      this.twit.post(sendMessageUrl, rawMessage, (err, data) => {
        if (err) {
          reject(err);
        }
        resolve(data);
      });
    });
  }

  __createStandardBodyResponseComponents(sentOutgoingMessage, sentRawMessage, rawBody) {
    // capture details from normal text response
    return {
      recipient_id: rawBody.event.message_create.target.recipient_id,
      message_id: rawBody.event.id,
    };
  }
}

module.exports = TwitterDMBot;
