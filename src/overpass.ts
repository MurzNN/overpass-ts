import type { OverpassJson, OverpassApiStatus, OverpassOptions } from "./types";
import type { Readable } from "stream";

import * as endpoints from "./endpoints";
import * as utils from "./utils";

import "isomorphic-fetch";

export * from "./types";

const defaultOpts: OverpassOptions = {
  endpoint: endpoints.main,
  numRetries: 1,
  retryPause: 2000,
  verbose: false,
  userAgent: "overpass-ts",
};

export function overpass(
  query: string,
  overpassOpts: Partial<OverpassOptions> = {}
): Promise<Response> {
  const opts = Object.assign({}, defaultOpts, overpassOpts);

  if (opts.verbose) {
    utils.consoleMsg(`endpoint ${opts.endpoint}`);
    utils.consoleMsg(`query ${query}`);
  }

  const fetchOpts = {
    body: `data=${encodeURIComponent(query)}`,
    method: "POST",
    mode: "cors",
    redirect: "follow",
    headers: {
      Accept: "*",
      "User-Agent": opts.userAgent,
    },
  } as RequestInit;

  return fetch(opts.endpoint, fetchOpts).then(async (resp) => {
    // handle non-200 errors
    if (!resp.ok) {
      if (resp.status === 400) {
        // 400 bad request

        // if bad request, error details sent along as html
        // load the html and parse it for detailed error

        const errors = utils
          .matchAll(/<\/strong>: ([^<]+) <\/p>/g, await resp.text())
          .map((error) => error.replaceAll("&quot;", '"'));

        throw new OverpassBadRequestError(query, errors);
      } else if (resp.status === 429) {
        // 429 too many requests / rate limited

        if (opts.numRetries == 0) throw new OverpassRateLimitError();

        return apiStatus(opts.endpoint).then((apiStatus) => {
          // if there are more slots available than being used
          // resend the request immediately (this happens sometimes)
          // if rate limit == 0 is unlimited
          if (
            apiStatus.rateLimit >
              apiStatus.slotsAvailableAfter.length +
                apiStatus.slotsRunning.length ||
            apiStatus.rateLimit == 0
          )
            return overpass(query, utils.oneLessRetry(opts));
          // if all slots are rate limited, pause until first rate limit over
          else {
            const lowestWaitTime =
              Math.min(0, ...apiStatus.slotsAvailableAfter) + 1;

            if (opts.verbose)
              utils.consoleMsg(`waiting ${lowestWaitTime}s for rate limit end`);

            return utils
              .sleep(lowestWaitTime * 1000)
              .then(() => overpass(query, utils.oneLessRetry(opts)));
          }
        });
      } else if (resp.status === 504) {
        // 504 gateway timeout

        if (opts.numRetries === 0) throw new OverpassGatewayTimeoutError();

        return utils
          .sleep(opts.retryPause)
          .then(() => overpass(query, utils.oneLessRetry(opts)));
      } else {
        throw new OverpassError(`${resp.status} ${resp.statusText}`);
      }
    }

    // print out response size if verbose
    if (opts.verbose && resp.headers.has("content-length"))
      utils.consoleMsg(
        `response payload ${utils.humanReadableBytes(
          parseInt(resp.headers.get("content-length") as string)
        )}`
      );

    return resp;
  });
}

export function overpassJson(
  query: string,
  opts: Partial<OverpassOptions> = {}
): Promise<OverpassJson> {
  return overpass(query, opts)
    .then((resp) => resp.json())
    .then((json: OverpassJson) => {
      // https://github.com/drolbr/Overpass-API/issues/94
      // a "remark" in the output means an error occurred after
      // the HTTP status code has already been sent

      if (json.remark) throw new OverpassError(json.remark);
      else return json as OverpassJson;
    });
}

export function overpassXml(
  query: string,
  opts: Partial<OverpassOptions> = {}
): Promise<string> {
  return overpass(query, opts)
    .then((resp) => resp.text())
    .then((text) => {
      // https://github.com/drolbr/Overpass-API/issues/94
      // a "remark" in the output means an error occurred after
      // the HTTP status code has already been sent

      // </remark> will always be at end of output, at same position
      if (text.slice(-18, -9) === "</remark>") {
        const textLines = text.split("\n");
        const errors = [];

        // loop backwards thru text lines skipping first 4 lines
        // collect each remark (there can be multiple)
        // break once remark is not matched
        for (let i = textLines.length - 4; i > 0; i--) {
          const remark = textLines[i].match(/<remark>\s*(.+)\s*<\/remark>/);
          if (remark) errors.push(remark[1]);
          else break;
        }

        throw new OverpassError(errors.join(", "));
      } else return text as string;
    });
}

export function overpassCsv(
  query: string,
  opts: Partial<OverpassOptions> = {}
): Promise<string> {
  return overpass(query, opts).then((resp) => resp.text());
}

export function overpassStream(
  query: string,
  opts: Partial<OverpassOptions> = {}
): Promise<Readable | ReadableStream | null> {
  return overpass(query, opts).then((resp) => resp.body);
}

export const apiStatus = (endpoint: string): Promise<OverpassApiStatus> =>
  fetch(endpoint.replace("/interpreter", "/status"))
    .then((resp) => {
      const responseType = resp.headers.get("content-type");

      if (!responseType || responseType.split(";")[0] !== "text/plain")
        throw new OverpassApiStatusError(
          `Response type incorrect (${responseType})`
        );

      return resp.text();
    })
    .then((statusHtml) => {
      const apiStatus = utils.parseApiStatus(statusHtml);

      if (!("clientId" in apiStatus))
        throw new OverpassApiStatusError(`Unable to parse API Status`);

      return apiStatus;
    });

export class OverpassError extends Error {
  constructor(message: string) {
    super(`Overpass Error: ${message}`);
  }
}

export class OverpassRateLimitError extends OverpassError {
  constructor() {
    super("429 Rate Limit Exceeded");
  }
}

export class OverpassBadRequestError extends OverpassError {
  constructor(query: string, errors: string[]) {
    super(`400 Bad Request\nErrors: ${errors.join("\n")}\nQuery: ${query}`);
  }
}

export class OverpassGatewayTimeoutError extends OverpassError {
  constructor() {
    super("504 Gateway Timeout");
  }
}

export class OverpassApiStatusError extends OverpassError {
  constructor(message: string) {
    super(`API Status error: ${message}`);
  }
}