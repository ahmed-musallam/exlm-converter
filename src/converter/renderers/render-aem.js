import jsdom from 'jsdom';
import Logger from '@adobe/aio-lib-core-logging';
import { isBinary, isHTML } from '../modules/utils/media-utils.js';
import renderAemAsset from './render-aem-asset.js';
import {
  isAbsoluteURL,
  relativeToAbsolute,
} from '../../common/utils/link-utils.js';
import {
  getAuthorBioData,
  updateEncodedMetadata,
  updateCoveoSolutionMetadata,
} from './utils/aem-page-meta-utils.js';
import { getMetadata, setMetadata } from '../modules/utils/dom-utils.js';

export const aioLogger = Logger('render-aem');

/**
 * Transforms metadata for Article pages
 */
async function transformAemPageMetadata(htmlString, params) {
  const dom = new jsdom.JSDOM(htmlString);
  const { document } = dom.window;

  updateEncodedMetadata(document, 'role');
  updateEncodedMetadata(document, 'level');
  updateCoveoSolutionMetadata(document);

  const coveoContentTypeMeta = getMetadata(document, 'coveo-content-type');
  if (coveoContentTypeMeta) setMetadata(document, 'type', coveoContentTypeMeta);

  const authorBioPages = getMetadata(document, 'author-bio-page');
  if (authorBioPages) {
    const authorBioUrls = authorBioPages.split(',').map((url) => url.trim());

    const promises = authorBioUrls.map(async (authorBioUrl) => {
      // eslint-disable-next-line no-use-before-define
      const { body } = await renderAem(authorBioUrl, params);
      return getAuthorBioData(body);
    });

    const results = await Promise.all(promises);

    const authorNames = results
      .map((result) => result.authorName)
      .filter(Boolean);
    const authorTypes = results
      .map((result) => result.authorType)
      .filter(Boolean);

    if (authorNames.length > 0)
      setMetadata(document, 'author-name', authorNames.join(','));

    if (authorTypes.includes('External')) {
      setMetadata(document, 'author-type', 'External');
    } else if (authorTypes.length > 0) {
      setMetadata(document, 'author-type', authorTypes.join(','));
    }
  }
  return dom.serialize();
}

/**
 * @param {string} htmlString
 */
function transformHTML(htmlString, aemAuthorUrl, path) {
  // FIXME: Converting images from AEM to absolue path. Revert once product fix in place.
  const dom = new jsdom.JSDOM(htmlString);
  const { document } = dom.window;
  const images = document.querySelectorAll('img');
  images.forEach((el) => {
    const uri = el.getAttribute('src');
    if (!isAbsoluteURL(uri)) el.src = relativeToAbsolute(uri, aemAuthorUrl);
  });
  const metaTags = document.querySelectorAll('meta[name="image"]');
  metaTags.forEach((el) => {
    const uri = el.getAttribute('content');
    if (uri.startsWith('/') && !isAbsoluteURL(uri))
      el.setAttribute('content', relativeToAbsolute(uri, aemAuthorUrl));
  });
  // no indexing rule for author bio and signup-flow-modal pages
  if (path.includes('/authors/') || path.includes('/signup-flow-modal')) {
    setMetadata(document, 'robots', 'NOINDEX, NOFOLLOW, NOARCHIVE, NOSNIPPET');
  }

  return dom.serialize();
}

function sendError(code, message) {
  return {
    statusCode: code,
    error: {
      code,
      message,
    },
  };
}

/**
 * Renders content from AEM UE pages
 */
export default async function renderAem(path, params) {
  const {
    aemAuthorUrl,
    aemOwner,
    aemRepo,
    aemBranch,
    authorization,
    sourceLocation,
  } = params;

  if (!authorization) {
    return sendError(401, 'Missing Authorization');
  }
  if (!aemAuthorUrl || !aemOwner || !aemRepo || !aemBranch) {
    return sendError(500, 'Missing AEM configuration');
  }

  const aemURL = `${aemAuthorUrl}/bin/franklin.delivery/${aemOwner}/${aemRepo}/${aemBranch}${path}?wcmmode=disabled`;
  const url = new URL(aemURL);

  const fetchHeaders = { 'cache-control': 'no-cache' };
  if (authorization) {
    fetchHeaders.authorization = authorization;
  }
  if (sourceLocation) {
    fetchHeaders['x-content-source-location'] = sourceLocation;
  }

  let resp;

  try {
    aioLogger.info('fetching AEM content', url);
    resp = await fetch(url, { headers: fetchHeaders });
  } catch (e) {
    aioLogger.error('Error fetching AEM content', e);
    return sendError(500, 'Internal Server Error');
  }

  if (!resp.ok) {
    return sendError(resp.status, 'Internal Server Error');
  }
  // note that this can contain charset, example 'text/html; charset=utf-8'
  const contentType = resp.headers.get('Content-Type');

  let body;
  let headers = { 'Content-Type': contentType };
  let statusCode = resp.status;
  if (isBinary(contentType)) {
    const { assetBody, assetHeaders, assetStatusCode } = await renderAemAsset(
      path,
      resp,
    );
    body = assetBody; // convert to base64 string, see: https://github.com/apache/openwhisk/blob/master/docs/webactions.md
    headers = { ...headers, ...assetHeaders };
    statusCode = assetStatusCode;
  } else if (isHTML(contentType)) {
    body = transformHTML(await resp.text(), aemAuthorUrl, path);
    // Update page metadata for AEM Pages
    body = await transformAemPageMetadata(body, params);
    // add custom header `x-html2md-img-src` to let helix know to use authentication with images with that src domain
    headers = { ...headers, 'x-html2md-img-src': aemAuthorUrl };
  } else {
    body = await resp.text();
  }

  // passthrough the same content type from AEM.
  return { body, headers, statusCode };
}
