import type {
  VercelRequest,
  VercelResponse,
  VercelRequestCookies,
  VercelRequestQuery,
  VercelRequestBody,
} from './types';
import { Server } from 'http';
import type { Bridge } from './bridge';

function getBodyParser(req: VercelRequest, body: Buffer) {
  return function parseBody(): VercelRequestBody {
    if (!req.headers['content-type']) {
      return undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { parse: parseContentType } = require('content-type');
    const { type } = parseContentType(req.headers['content-type']);

    if (type === 'application/json') {
      try {
        const str = body.toString();
        return str ? JSON.parse(str) : {};
      } catch (error) {
        throw new ApiError(400, 'Invalid JSON');
      }
    }

    if (type === 'application/octet-stream') {
      return body;
    }

    if (type === 'application/x-www-form-urlencoded') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { parse: parseQS } = require('querystring');
      // note: querystring.parse does not produce an iterable object
      // https://nodejs.org/api/querystring.html#querystring_querystring_parse_str_sep_eq_options
      return parseQS(body.toString());
    }

    if (type === 'text/plain') {
      return body.toString();
    }

    return undefined;
  };
}

function getQueryParser({ url = '/' }: VercelRequest) {
  return function parseQuery(): VercelRequestQuery {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { parse: parseURL } = require('url');
    return parseURL(url, true).query;
  };
}

function getCookieParser(req: VercelRequest) {
  return function parseCookie(): VercelRequestCookies {
    const header: undefined | string | string[] = req.headers.cookie;

    if (!header) {
      return {};
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { parse } = require('cookie');
    return parse(Array.isArray(header) ? header.join(';') : header);
  };
}

function status(res: VercelResponse, statusCode: number): VercelResponse {
  res.statusCode = statusCode;
  return res;
}

function redirect(
  res: VercelResponse,
  statusOrUrl: string | number,
  url?: string
): VercelResponse {
  if (typeof statusOrUrl === 'string') {
    url = statusOrUrl;
    statusOrUrl = 307;
  }
  if (typeof statusOrUrl !== 'number' || typeof url !== 'string') {
    throw new Error(
      `Invalid redirect arguments. Please use a single argument URL, e.g. res.redirect('/destination') or use a status code and URL, e.g. res.redirect(307, '/destination').`
    );
  }
  res.writeHead(statusOrUrl, { Location: url }).end();
  return res;
}

function setCharset(type: string, charset: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parse, format } = require('content-type');
  const parsed = parse(type);
  parsed.parameters.charset = charset;
  return format(parsed);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createETag(body: any, encoding: 'utf8' | undefined) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const etag = require('etag');
  const buf = !Buffer.isBuffer(body) ? Buffer.from(body, encoding) : body;
  return etag(buf, { weak: true });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function send(
  req: VercelRequest,
  res: VercelResponse,
  body: any
): VercelResponse {
  let chunk: unknown = body;
  let encoding: 'utf8' | undefined;

  switch (typeof chunk) {
    // string defaulting to html
    case 'string':
      if (!res.getHeader('content-type')) {
        res.setHeader('content-type', 'text/html');
      }
      break;
    case 'boolean':
    case 'number':
    case 'object':
      if (chunk === null) {
        chunk = '';
      } else if (Buffer.isBuffer(chunk)) {
        if (!res.getHeader('content-type')) {
          res.setHeader('content-type', 'application/octet-stream');
        }
      } else {
        return json(req, res, chunk);
      }
      break;
  }

  // write strings in utf-8
  if (typeof chunk === 'string') {
    encoding = 'utf8';

    // reflect this in content-type
    const type = res.getHeader('content-type');
    if (typeof type === 'string') {
      res.setHeader('content-type', setCharset(type, 'utf-8'));
    }
  }

  // populate Content-Length
  let len: number | undefined;
  if (chunk !== undefined) {
    if (Buffer.isBuffer(chunk)) {
      // get length of Buffer
      len = chunk.length;
    } else if (typeof chunk === 'string') {
      if (chunk.length < 1000) {
        // just calculate length small chunk
        len = Buffer.byteLength(chunk, encoding);
      } else {
        // convert chunk to Buffer and calculate
        const buf = Buffer.from(chunk, encoding);
        len = buf.length;
        chunk = buf;
        encoding = undefined;
      }
    } else {
      throw new Error(
        '`body` is not a valid string, object, boolean, number, Stream, or Buffer'
      );
    }

    if (len !== undefined) {
      res.setHeader('content-length', len);
    }
  }

  // populate ETag
  let etag: string | undefined;
  if (
    !res.getHeader('etag') &&
    len !== undefined &&
    (etag = createETag(chunk, encoding))
  ) {
    res.setHeader('etag', etag);
  }

  // strip irrelevant headers
  if (204 === res.statusCode || 304 === res.statusCode) {
    res.removeHeader('Content-Type');
    res.removeHeader('Content-Length');
    res.removeHeader('Transfer-Encoding');
    chunk = '';
  }

  if (req.method === 'HEAD') {
    // skip body for HEAD
    res.end();
  } else if (encoding) {
    // respond with encoding
    res.end(chunk, encoding);
  } else {
    // respond without encoding
    res.end(chunk);
  }

  return res;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function json(
  req: VercelRequest,
  res: VercelResponse,
  jsonBody: any
): VercelResponse {
  const body = JSON.stringify(jsonBody);

  // content-type
  if (!res.getHeader('content-type')) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
  }

  return send(req, res, body);
}

export class ApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function sendError(
  res: VercelResponse,
  statusCode: number,
  message: string
) {
  res.statusCode = statusCode;
  res.statusMessage = message;
  res.end();
}

function setLazyProp<T>(req: VercelRequest, prop: string, getter: () => T) {
  const opts = { configurable: true, enumerable: true };
  const optsReset = { ...opts, writable: true };

  Object.defineProperty(req, prop, {
    ...opts,
    get: () => {
      const value = getter();
      // we set the property on the object to avoid recalculating it
      Object.defineProperty(req, prop, { ...optsReset, value });
      return value;
    },
    set: value => {
      Object.defineProperty(req, prop, { ...optsReset, value });
    },
  });
}

export function createServerWithHelpers(
  handler: (req: VercelRequest, res: VercelResponse) => void | Promise<void>,
  bridge: Bridge
) {
  const server = new Server(async (_req, _res) => {
    const req = _req as VercelRequest;
    const res = _res as VercelResponse;

    try {
      const reqId = req.headers['x-now-bridge-request-id'];

      // don't expose this header to the client
      delete req.headers['x-now-bridge-request-id'];

      if (typeof reqId !== 'string') {
        throw new ApiError(500, 'Internal Server Error');
      }

      const event = bridge.consumeEvent(reqId);

      setLazyProp<VercelRequestCookies>(req, 'cookies', getCookieParser(req));
      setLazyProp<VercelRequestQuery>(req, 'query', getQueryParser(req));
      setLazyProp<VercelRequestBody>(
        req,
        'body',
        getBodyParser(req, event.body)
      );

      res.status = statusCode => status(res, statusCode);
      res.redirect = (statusOrUrl, url) => redirect(res, statusOrUrl, url);
      res.send = body => send(req, res, body);
      res.json = jsonBody => json(req, res, jsonBody);

      try {
        await handler(req, res);
      } catch (err) {
        console.log(`Error from API Route ${req.url}: ${err.stack}`);
        process.exit(1);
      }
    } catch (err) {
      console.log(`Error while handling ${req.url}: ${err.message}`);
      process.exit(1);
    }
  });

  return server;
}
