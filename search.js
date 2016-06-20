/*
 * TESS searcher
 */

// jshint node:true
'use strict';

// CONSTANTS
var HOST = 'http://tmsearch.uspto.gov';
var HANDLER_URL = HOST + '/bin/gate.exe';
var LOGIN = HANDLER_URL + '?f=login&p_lang=english&p_d=trmk';
var SERIAL_ROW_NUMBER = 2;
var IMAGE_HANDLER_URL = HOST + '/ImageAgent/ImageAgentProxy?getImage={serialNumber}';

var selectors = {
    documentLink: 'a[href*="f=doc"]',
    logoutButton: 'input[value="Logout"]',
    resultsTable: 'table:contains(Filing Date)',
    searchForm: 'form[name=search_text]',
    searchPageLink: 'a:contains("Free Form")',
    titleContainingError: 'title:contains(Error)'
};

var MAX_PARALLEL_DOCUMENTS = 1;  // TESS sometimes throws errors when same session requests multiple pages at once
//var MAX_PARALLEL_IMAGES = 10;

var rp = require('request-promise');
var Promise = require('bluebird').Promise;
var cheerio = require('cheerio');
var extend = require('extend');

var jar = rp.jar();

rp = rp.defaults({
    jar: jar,
    //proxy: 'http://localhost:8888',
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 6.3; rv:36.0) Gecko/20100101 Firefox/36.0 (compatible; TESS-GIF)'
    }
});

/**
 * @param {Cheerio} $form - form element to serialize
 * @returns {object} - object mapping field names to values
 */
function serializeForm($form) {
    return $form.serializeArray().reduce(function (o, v) {
        o[v.name] = v.value;
        return o;
    }, {});
}

/**
 * @param {string} message - user-facing error message
 * @param {object|string} [details] - any extra error details for debug purposes
 */
function TessError(message, details) {
    this.name = 'TessError';
    this.message = message;
    this.details = details;
}
TessError.prototype = Object.create(Error.prototype);
TessError.prototype.constructor = TessError;


/**
 * @param {string} message - user-facing progress message
 * @param {object|string} [details] - details for debug purposes
 */
function TessProgress(message, details) {
    this.message = message;
    this.details = details;
}


/**
 * @param {string} message - user-facing progress message
 * @param {number} fraction - fraction of the current task this progress event marks completed
 * @param {document} object - latest loaded document.
 */
function TessFractionalProgress(message, fraction, document) {
    this.message = message;
    this.fraction = fraction;

    // Don't need this in the payload.  Also, don't affect referenced variable.
    let docCopy = extend({}, document)
    docCopy._html = null;

    this.document = docCopy;
}


/**
 * @param {string} searchTerm - TESS free-form query
 * @param {function} [progressHandler] - optional handler for progress-related events
 */
function search(searchTerm, progressHandler) {

    /**
     * Gets a TESS session, returning a Disposer for session cleanup
     * @returns Bluebird.Promise.prototype.disposer
     */
    function getSession() {

        progressHandler(new TessProgress('Logging in to TESS...'));

        return rp(LOGIN)
            .catch(function (e) {
                throw new TessError('Encountered error logging in to TESS', e);
            })
            .disposer(function (pageData) {
                var $ = cheerio.load(pageData),
                    $logoutForm = $(selectors.logoutButton).closest('form');
                if (!$logoutForm.length) {
                    return new TessError('Failed to find TESS logout form!');
                }

                progressHandler(new TessProgress('Logging out of TESS...'));

                return rp.post({
                    uri: HANDLER_URL,
                    form: serializeForm($logoutForm)
                }).catch(function () {
                    return new TessError('Encountered an error disposing TESS session!');
                });
            });
    }

    return Promise.using(getSession(), function (entryPageHtml) {
        var $ = cheerio.load(entryPageHtml),

        // Get a link to the search page (which includes session token)
        link = $(selectors.searchPageLink);
        if (!link.length) {
            throw new TessError('Failed to find link to search page!', entryPageHtml);
        }

        // Load the search page
        return rp(HOST + link.attr('href'), { resolveWithFullResponse: true })
            .then(function (response) {
                // Search
                var $ = cheerio.load(response.body),
                    formData = serializeForm($(selectors.searchForm));
                formData.p_s_ALL = searchTerm;
                formData.a_search = 'Submit Query';
                formData.p_L = 500;  // 500 results/page
                //jar.setCookie(rp.cookie('queryCookie=' + encodeURIComponent(formData.p_s_ALL)), HOST);

                progressHandler(new TessProgress('Querying ' + searchTerm));

                return rp.post({
                    uri: HANDLER_URL,
                    form: formData,
                    resolveWithFullResponse: true,
                    headers: {
                        Referer: response.request.href
                    }
                });
            })
            .then(function (response) {
                var $ = cheerio.load(response.body),
                    titleContainingError = $(selectors.titleContainingError),
                    requestsCompleted = 0,
                    documentData;

                if (titleContainingError.length) {
                    throw new TessError('Encountered an error querying TESS', $('body').text());
                }

                progressHandler(new TessProgress('Got search response', response.body));

                documentData = $('td:nth-of-type(' + SERIAL_ROW_NUMBER + ') ' + selectors.documentLink).toArray().map(function (el) {

                    return {
                        wordMark: $(el).parent().next().next().text(),
                        imageUrl: IMAGE_HANDLER_URL.replace('{serialNumber}', $(el).html()),
                        docUrl: HOST + $(el).attr('href')
                    };
                });

                function announceProgress(progress, total, newDocument) {
                    var message = 'Retrieving ' + total + ' documents',
                        fraction = (progress > 0) ? progress / total : 0;
                    progressHandler(new TessFractionalProgress(message, fraction, newDocument));
                }

                function getPromiseForDocument(doc) {
                    return rp.get(doc.docUrl)
                        .then(function (document) {
                            var $ = cheerio.load(document);
                            requestsCompleted++;

                            doc.full = {};
                            $(selectors.resultsTable).find('tr').each(function (i, el) {
                                var fieldName = $(el).find('td:first-of-type').text().trim(),
                                    fieldValue = $(el).find('td:last-of-type').text().trim();
                                doc.full[fieldName] = fieldValue;
                            });
                            doc._html = $('body').html();
                            announceProgress(requestsCompleted, documentData.length, doc);
                            return doc;
                        });
                }

                return Promise.map(documentData, getPromiseForDocument, {
                    concurrency: MAX_PARALLEL_DOCUMENTS
                });

            });
    });
}

module.exports = search;
