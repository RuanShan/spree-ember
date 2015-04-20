/* globals StateMachine */

import Ember from 'ember';

/**
  Provides Current Order and Checkout Functionality to the Spree service.

  @class Checkouts
  @namespace Spree Ember
  @module spree-ember-core/mixins/checkouts
  @extends Ember.Mixin
*/
export default Ember.Mixin.create({
  /**
    Triggered whenever a Spree Server request fails.

    @event serverError
    @param {Object} error The error object returned from the Spree Server.
  */

  /**
    Triggered whenever a Line Item is created or updated.

    @event didAddToCart
    @param {Object} lineItem The newly updated lineItem object
  */

  /**
    Triggered whenever a new Order is created for the checkout user.

    @event didCreateNewOrder
    @param {Object} order The newly created order object
  */

  /**
    Triggered whenever the Current Order changes State.

    @event checkoutStateDidChange
    @param {String} order A string representing the new state.
  */

  /**
    Triggered whenever the Current Order reached it's "Complete" State.

    @event currentOrderDidComplete
    @param {String} order A string representing the new state.
  */

  /**
    A method called in the `spree-ember-checkouts` initializer after the
    `Checkouts` mixin is applied to the Spree service, to initialize functionality
    in this mixin.

    @method initCheckouts
    @param {Ember.Application} application A reference to the initializing Application.
    @return {Boolean} Always resolves to `true`.
  */
  initCheckouts: function(application, stateMachineParams) {
    this.setProperties(stateMachineParams);
    
    this.restore();
    var orderId = this.get('orderId');
    
    var _this = this;
    if (orderId) {
      application.deferReadiness();
      this.store.find('order', orderId).then(
        function(currentOrder) {
          _this.set('currentOrder', currentOrder);
          _this._setupStateMachineForOrder(currentOrder);
          application.advanceReadiness();
        },
        function(error) {
          application.advanceReadiness();
          _this.persist({
            guestToken: null,
            orderId: null
          });
          _this.trigger('serverError', error);
          return error;
        }
      );
    }
    return true;
  },

  /**
    The token used to Authenticate the current user against the current order.  Persisted
    to local storage via `spree-ember-core/mixins/storable`.  This property is
    sent to the Spree server via the header `X-Spree-Order-Token`.

    @property guestToken
    @type String
    @readOnly
    @default null
  */
  guestToken: null,

  /**
    The user's Current Order number, persisted to local storage via
    `spree-ember-core/mixins/storable`.  This property is sent to the Spree
    server via the header `X-Spree-Order-Id`.

    @property orderId
    @type String
    @readOnly
    @default null
  */
  orderId: null,
  
  /**
    A reference to the Current Order.  It is only set twice in this code,
    once on Application initialization (in the case it was persisted), and once
    when a new order is created through the internal method `_createNewOrder`.

    @property currentOrder
    @type DS.Model
    @default null
  */
  currentOrder: null,

  /**
    Adds state machine functionality to the Spree service.

    @method _setupStateMachineForOrder
    @private
    @param {Ember.Object} order A reference to the Current Order
    @return {StateMachine} Returns the newly instantiated StateMachine instance.
  */
  _setupStateMachineForOrder: function(order) {
    return StateMachine.create({
      initial:   order.get('state'),
      events:    this.get('orderStateEvents'),
      callbacks: this.get('orderStateCallbacks'),
    }, this);
  },

  /**
    If a state name is passed to this method, the state machine will attempt to
    transition directly to that state.  If not, we will attempt to transition
    to the next state in the checkout flow.

    @method transitionCheckoutState
    @param {String} stateName Optional, a state to attempt transition to.
    @return {Function} A dynamically created IIFE corresponding to a State
    Machine event name.  See `orderStateCallbacks`.
  */
  transitionCheckoutState: function(stateName) {
    var nextStateName;

    if (stateName) {
      nextStateName = stateName;
    } else {
      var allStates = this.get('currentOrder.checkoutSteps');
      if (this.current === "cart") {
        nextStateName = allStates[0];
      } else if (this.current === "complete") {
        throw new Error("Spree Ember: Can't transition order past 'Complete' state.");
      } else {
        nextStateName = allStates[allStates.indexOf(this.current) + 1];
      }
    }

    return new Function(
      "return this.transitionTo"+Ember.String.capitalize(nextStateName)+"();"
    ).apply(this);
  },

  /**
    Saves the Current Order via the Spree API `checkouts` endpoint.  This method
    first serializes the order in a format that the endpoint expects, and hits
    that endpoint.

    If the server determines that the Order can transition to another state, it
    will.  Therefore, we only use this method inside of the State Machine
    callback, so we can handle the Client Side state machine appropriately.

    @method saveCurrentOrder
    @return {Ember.RSVP.Promise} A promise that resolves to either a successful
    server response (that may contain errors in the payload), or an AJAX error.
  */
  saveCurrentOrder: function() {
    var _this    = this;
    var order    = this.get('currentOrder');
    var orderId  = order.get('id');
    var adapter  = this.get('container').lookup('adapter:-spree');
    var url      = adapter.buildURL('checkout', orderId);
    var data     = order.serialize();

    return adapter.ajax(url, 'PUT', { data: data }).then(
      function(orderPayload) {
        _this.store.pushPayload('order', orderPayload);
        return _this.store.find('order', orderPayload.order.id);
      },
      function(error) {
        _this.trigger('serverError', error);
        return error;
      }
    );
  },

  /**
    This method will attempt to force the Order's state to the next State.  It's
    necessary for the "confirm" -> "complete" transition for Spree, and also useful
    for triggering validation errors, when it's not clear why an order won't advance
    to the next state.

    @method advanceCurrentOrder 
    @return {Ember.RSVP.Promise} A promise that resolves to either a successful
    server response (that may contain errors in the payload), or an AJAX error.
  */
  advanceCurrentOrder: function() {
    var _this   = this;
    var order   = this.get('currentOrder');
    var orderId = order.get('id');
    var adapter = this.get('container').lookup('adapter:-spree');
    var url     = adapter.buildURL('checkout', orderId)+"/next.json";

    return adapter.ajax(url, 'PUT').then(
      function(orderPayload) {
        _this.store.pushPayload('order', orderPayload);
        return _this.store.find('order', orderPayload.order.id);
      },
      function(error) {
        _this.trigger('serverError', error);
        return error;
      }
    );
  },

  /**
    Adds a lineItem to the currentOrder. If there is no Current Order,
    Spree Ember will request a new order from the server, and set it as the
    Current Order on the Spree service.

    @method addToCart
    @param {DS.Model} variant A class of the variant model
    @param {Integer} quantity A quantity for the Line Item.
    @return {Ember.RSVP.Promise} A promise that resolves to the newly saved Line Item.
  */
  addToCart: function(variant, quantity) {
    var _this        = this;
    var currentOrder = this.get('currentOrder');

    if (currentOrder) {
      return _this._saveLineItem(variant, quantity, currentOrder);
    } else {
      return this._createNewOrder().then(
        function(currentOrder) {
          return _this._saveLineItem(variant, quantity, currentOrder);
        },
        function(error) {
          _this.trigger('serverError', error);
          return error;
        }
      );
    }
  },

  /**
    An internal method for saving Line Items.  If it is called for a variant that
    is already in the current order, it will add to the corresponding Line Item's
    quantity, otherwise it will create a new Line Item for that variant.

    @method _saveLineItem
    @private
    @param {Ember.Object} variant A class of the variant model
    @param {Integer} quantity A quantity for the `lineItem`
    @param {Ember.Object} order The corresponding order
    @return {Ember.RSVP.Promise} A promise that resolves to the newly created or
    updated `lineItem` object.
  */
  _saveLineItem: function(variant, quantity, order) {
    var _this = this;
    var lineItem = order.get('lineItems').findBy('variant', variant);

    if (lineItem) {
      var currentQuantity = lineItem.get('quantity');
      lineItem.set('quantity', currentQuantity + quantity);
    } else {
      lineItem = this.store.createRecord('lineItem', {
        variant:  variant,
        quantity: quantity
      });
    }

    return lineItem.save().then(
      function(lineItem) {
        _this.trigger('didAddToCart', lineItem);
        return lineItem;
      },
      function(error) {
        _this.trigger('serverError', error);
        return error;
      }
    );
  },

  /**
    Will attempt to create a new Order for the checkout user, and save the `orderId`
    and `guestToken` to the Spree service, so that it will persist across page
    refreshes.  It will also initiate the state machine for the current order.

    @method _createNewOrder
    @private
    @return {Ember.RSVP.Promise} A promise that resolves to the newly created
    Spree Order.
  */
  _createNewOrder: function() {
    var _this = this;
    return this.store.createRecord('order').save().then(
      function(newOrder) {
        _this.set('currentOrder', newOrder);
        _this.persist({
          guestToken: newOrder.get('guestToken'),
          orderId:    newOrder.get('id')
        });
        _this.trigger('didCreateNewOrder', newOrder);
        _this._setupStateMachineForOrder(newOrder);
        return newOrder;
      },
      function(error) {
        _this.trigger('serverError', error);
        return error;
      }
    );
  },

  /**
    Clears the current order and any reference to it.

    @method clearCurrentOrder
    @return {Boolean} Always returns `true`.
  */
  clearCurrentOrder: function() {
    this.persist({
      guestToken: null,
      orderId: null
    });
    this.set('currentOrder', null);
    return true;
  }
});
