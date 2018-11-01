import Mixin from '@ember/object/mixin';
import { assign } from '@ember/polyfills';
import RSVP from 'rsvp';
import fetch from 'fetch';
import { serializeQueryParams } from '../utils/serialize-query-params';
import DS from 'ember-data';
import { Value as JSONValue } from 'json-typescript';
import { runInDebug } from '@ember/debug';

/// <reference types="jquery" />
/// <reference types="dom" />

/**
 * Helper function to create a plain object from the response's Headers.
 * Consumed by the adapter's `handleResponse`.
 * @param {Headers} headers
 * @returns {Object}
 */
export function headersToObject(headers: Headers) {
  let headersObject: { [k: string]: string } = {};

  if (headers) {
    headers.forEach((value, key) => (headersObject[key] = value));
  }

  return headersObject;
}
/**
 * Helper function that translates the options passed to `jQuery.ajax` into a format that `fetch` expects.
 * @param {Object} _options
 * @param {DS.Adapter} adapter
 * @returns {Object}
 */
export function mungOptionsForFetch(
  _options: JQueryAjaxSettings & { url: string },
  adapter: DS.RESTAdapter
) {
  const options = assign(
    {
      credentials: 'same-origin'
    },
    _options
  );

  let adapterHeaders = adapter.get('headers');
  if (adapterHeaders) {
    options.headers = assign(options.headers || {}, adapterHeaders);
  }

  // Default to 'GET' in case `type` is not passed in (mimics jQuery.ajax).
  options.method = options.type || 'GET';

  if (options.data) {
    // GET and HEAD requests can't have a `body`
    if (options.method === 'GET' || options.method === 'HEAD') {
      // If no options are passed, Ember Data sets `data` to an empty object, which we test for.
      if (Object.keys(options.data).length) {
        // Test if there are already query params in the url (mimics jQuey.ajax).
        const queryParamDelimiter = options.url.indexOf('?') > -1 ? '&' : '?';
        options.url += `${queryParamDelimiter}${serializeQueryParams(
          options.data
        )}`;
      }
    } else {
      // NOTE: a request's body cannot be an object, so we stringify it if it is.
      // JSON.stringify removes keys with values of `undefined` (mimics jQuery.ajax).
      options.body = JSON.stringify(options.data);
    }
  }

  // Mimics the default behavior in Ember Data's `ajaxOptions`, namely to set the
  // 'Content-Type' header to application/json if it is not a GET request and it has a body.
  if (
    options.method !== 'GET' &&
    options.body &&
    (options.headers === undefined ||
      !(options.headers['Content-Type'] || options.headers['content-type']))
  ) {
    options.headers = options.headers || {};
    options.headers['Content-Type'] = 'application/json; charset=utf-8';
  }

  return options;
}
/**
 * Function that always attempts to parse the response as json, and if an error is thrown,
 * returns an object with 'data' set to null if the response is
 * a success and has a status code of 204 (No Content) or 205 (Reset Content) or if the request method was 'HEAD',
 * and the plain payload otherwise.
 * @param {Response} response
 * @param {Object} requestData
 * @returns {Promise}
 */
export function determineBodyPromise(response: Response, requestData: any) {
  return response.text().then(function(payload: string | undefined) {
    try {
      payload = JSON.parse(payload as string);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      const status = response.status;
      if (
        response.ok &&
        (status === 204 || status === 205 || requestData.method === 'HEAD')
      ) {
        payload = undefined;
      } else {
        console.warn('This response was unable to be parsed as json.', payload);
      }
    }
    return payload;
  });
}


function isRESTAdapter(obj: any): obj is DS.RESTAdapter {
  return typeof obj.ajaxOptions === 'function';
}

export default Mixin.create({
  get adapter(): DS.RESTAdapter {
    return this as any;
  },

  init() {
    runInDebug(() => {
      
    })
    // TODO: throw if this is mixed into anything other than a DS.RESTAdapter
  }
  /**
   * @param {String} url
   * @param {String} type
   * @param {Object} _options
   * @returns {Object}
   * @override
   */

  ajaxOptions(url: string, type: string, options: JQueryAjaxSettings = {}) {
    options.url = url;
    options.type = type;
    return mungOptionsForFetch({ ...options, url, type }, this.adapter);
  },

  /**
   * @param {String} url
   * @param {String} type
   * @param {Object} options
   * @override
   */
  ajax(url: string, type: string, options: { url?: string; type?: string }) {
    const requestData = {
      url,
      method: type
    };

    const hash = this.ajaxOptions(url, type, options);

    return this._ajaxRequest(hash)
      .catch(error => {
        throw error;
      })
      .then(response => {
        return RSVP.hash({
          response,
          payload: determineBodyPromise(response, requestData)
        });
      })
      .then(({ response, payload }) => {
        if (response.ok) {
          return this.ajaxSuccess(
            this as any,
            response,
            payload || '',
            requestData
          );
        } else {
          throw this.ajaxError(this, response, payload, requestData);
        }
      });
  },

  /**
   * Overrides the `_ajaxRequest` method to use `fetch` instead of jQuery.ajax
   * @param {Object} options
   * @override
   */
  _ajaxRequest(options: any): RSVP.Promise<Response> {
    return this._fetchRequest(options.url, options);
  },

  /**
   * A hook into where `fetch` is called.
   * Useful if you want to override this behavior, for example to multiplex requests.
   * @param {String} url
   * @param {Object} options
   */
  _fetchRequest(url: string, options: RequestInit) {
    return fetch(url, options);
  },

  /**
   * @param {Object} adapter
   * @param {Object} response
   * @param {Object} payload
   * @param {Object} requestData
   * @override
   */
  ajaxSuccess(
    adapter: DS.RESTAdapter,
    response: Response,
    payload: {},
    requestData: {}
  ) {
    const returnResponse: { isAdapterError: boolean } = adapter.handleResponse(
      response.status,
      headersToObject(response.headers),
      payload,
      requestData
    ) as any;

    if (returnResponse && returnResponse.isAdapterError) {
      return RSVP.Promise.reject(returnResponse);
    } else {
      return returnResponse;
    }
  },

  /**
   * Allows for the error to be selected from either the
   * response object, or the response data.
   * @param {Object} response
   * @param {Object} payload
   */
  parseFetchResponseForError(response: Response, payload: JSONValue) {
    return payload || response.statusText;
  },

  /**
   * @param {Object} adapter
   * @param {Object} response
   * @param {String|Object} payload
   * @param {Object} requestData
   * @param {Error} error
   * @override
   */

  ajaxError(
    adapter: DS.RESTAdapter,
    response?: Response,
    payload: JSONValue,
    requestData: {},
    error?: any
  ) {
    if (error) {
      return error;
    } else {
      const parsedResponse = (adapter as any).parseFetchResponseForError(
        response,
        payload
      );
      return adapter.handleResponse(
        response.status,
        headersToObject(response.headers),
        (adapter as any).parseErrorResponse(parsedResponse) || payload,
        requestData
      );
    }
  }
});
