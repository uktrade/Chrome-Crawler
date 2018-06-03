var tabs = ["Report","Queued","Crawling","Crawled","Errors"];
var allPages = {};
var allCookiesSeen = {};
var allCookies = [];
var allSymbolsSeen = {};
var allSymbols = [];
var startingPages = [];
var latestUpdate = new Date();
var appState = "stopped";

// There are multiple content scripts, i.e. from iframes
// so we need a bit of state to accumulate them
var latestLinks = [];
var latestSymbols = [];
var messagesReceived = null;

chrome.runtime.onConnect.addListener((port) => {
    port.onMessage.addListener((msg) => {
        if (appState == 'stopped') return;

        msg.links.forEach((link) => {
            latestLinks.push(link);
        });
        msg.symbols_accessed.forEach((symbol) => {
            latestSymbols.push(symbol);
        });

        messagesReceived();
    });
});

function clearAnalysis() {
    latestLinks = [];
    latestSymbols = [];
}

function waitForAnalysis() {
    return new Promise((resolve, reject) => {
        messagesReceived = debounce(() => {
            resolve({links: latestLinks, symbols_accessed: latestSymbols})
        }, 500);
    });
}

async function beginCrawl(url, maxDepth) { 
    reset();    
    appState = "crawling";
    settings.root = url;
    settings.maxDepth = maxDepth;
    var urls = url.split(',');
    urls.forEach((singleUrl) => {
        allPages[singleUrl] = {url:singleUrl, state:"queued", depth:0};
    });
    startingPages = urls;
    var allCookies = await getCookies();
    console.log("Deleting all cookies");
    await Promise.all(allCookies.map(removeCookie));
    console.log("All cookies deleted");
    crawlMore();
}

function getCookies() {
    return new Promise((resolve, reject) => {
        chrome.cookies.getAll({}, resolve);
    });
}

function removeCookie(cookie) {
    var url = (cookie.secure ? "https" : "http") + "://" + cookie.domain + cookie.path;
    return new Promise((resolve, reject) => {
        chrome.cookies.remove({"url": url, "name": cookie.name}, (details) => {
            details === null ? reject() : resolve();
        });
    });  
};

function onTabStatusComplete(tabId) {
    return new Promise((resolve, reject) => {
        var listener = (updatedTabId, info) => {
            if (updatedTabId == tabId && info.status == 'complete') {
                resolve();
                chrome.tabs.onUpdated.removeListener(listener);
            }
        }
        chrome.tabs.onUpdated.addListener(listener);
    });
}

function sendMessage(tabId, message) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, resolve);
    });
}

function cookieKey(cookie) {
    return  '___DOMAIN___' + cookie.domain + "___NAME___" + cookie.name + "___PATH___" + cookie.path;
}

async function crawlPage(page)
{
    console.log("Starting Crawl --> "+JSON.stringify(page));
    clearAnalysis();

    var tabs = await tabQuery({active: true, currentWindow: true});
    chrome.tabs.update(tabs[0].id, {
        url: page.url
    });
    await onTabStatusComplete(tabs[0].id);

    var response = await waitForAnalysis();
    console.log('error',  chrome.runtime.lastError);
    if (response == null) {
        throw new Error('No response from page');
    }

    var newPages = (response && response.links ? response.links : []).filter(function(linkURL) {
        var anyStartsWith = startingPages.some(function(startingPage) {
            return startsWith(linkURL, startingPage);
        });
        return anyStartsWith && !allPages[linkURL];
    }).map((linkURL) => {
        return {
            depth: page.depth+1,
            url: linkURL,
            state: page.depth == settings.maxDepth ? "max_depth" : "queued"
        }
    });

    console.log("Page Crawled --> "+JSON.stringify({page:page, counts:newPages.length}));
    return [newPages, response.symbols_accessed];
}

async function getNewCookies(page) {
    var cookies = await getCookies();

    return cookies.filter(function(cookie) {
        return !(cookieKey(cookie) in allCookiesSeen)
    }).map((cookie) => {
        var expires = cookie.session ? 'session' : dateFns.distanceInWordsStrict(
            new Date(),
            cookie.expirationDate * 1000,
            {partialMethod: 'ceil'}
        );
        return {
            domain: cookie.domain,
            path: cookie.path,
            name: cookie.name,
            expirationDate: expires,
            firstSeen: page.url,
            firstValue: cookie.value
        };
    });
}

function getNewSymbols(page, symbols) {
    return symbols.filter((symbol) => {
        return !(symbol.name in allSymbolsSeen);
    }).map((symbol) => {
        return {
            name: symbol.name,
            scriptUrl: symbol.scriptUrl,
            firstSeen: page.url
        };
    });
}

function timeoutUntilReject(ms, message) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(message);
        }, ms);
    });
}

async function crawlMore() {
    appState = "crawling";

    while (appState == "crawling" && getURLsInTab("Queued").length > 0) {
        var page = getURLsInTab("Queued")[0];
        page.state = "crawling";
        chrome.runtime.sendMessage({message: "refresh_page"});

        var newPages;
        var symbolsAccessed;
        try {
            [newPages, symbolsAccessed] = await Promise.race([crawlPage(page), timeoutUntilReject(10000)]);
        } catch(e) {
            page.state = "error";
            newPages = [];
            symbolsAccessed = [];
        } finally {
            page.state = page.state != "error" ? "crawled" : page.state;
        }

        newPages.forEach(function(page) {
            allPages[page.url] = page;
        });

        // Even in the case of error, cookies, might have changed
        var newCookies = await getNewCookies(page);
        newCookies.forEach(function(cookie) {
            allCookiesSeen[cookieKey(cookie)] = true
            allCookies.push(cookie)
        });

        var newSymbols = getNewSymbols(page, symbolsAccessed).forEach((symbol) => {
            allSymbolsSeen[symbol.name] = true;
            allSymbols.push(symbol);
        });

        latestUpdate = new Date();
    }

    // We are either finished, or we have paused
    appState = (appState == "pausing" && getURLsInTab("Queued").length) ? "paused" : "stopped";
    chrome.runtime.sendMessage({message: "refresh_page"});
}

function getURLsInTab(tab) {
    return Object.values(allPages).filter((o) => {
        return (tab=="Queued"   && o.state=="queued")   ||
               (tab=="Crawling" && o.state=="crawling") ||
               (tab=="Crawled"  && o.state=="crawled")  ||
               (tab=="Errors"   && o.state=="error");
    });
}

function pause() {
    appState = "pausing";
    chrome.runtime.sendMessage({message: "refresh_page"});
}

function stop() {
    appState = "stopped";
    chrome.runtime.sendMessage({message: "refresh_page"});
}

function reset() {
    console.log('resetting');
    appState = "stopped";

    allPages = {};  
    allCookiesSeen = {};
    allCookies = [];
    allSymbolsSeen = {};
    allSymbols = [];
    chrome.runtime.sendMessage({message: "refresh_page"});
}

// There doesn't seem to be a nicer way to get Chrome to consistently use
// a different icon in incognito. Might have to try to have the same icon
// that looks ok in both
function setLightIcon(tabId) {
    chrome.browserAction.setIcon({path: 'images/paws_light.png', tabId: tabId});
}

if (chrome.extension.inIncognitoContext) {
    (async function setIcon() {
        var tabs = await tabQuery({active: true, currentWindow: true});
        setLightIcon(tabs[0].id);
    })();

    chrome.tabs.onCreated.addListener((tab) => {
        setLightIcon(tab.id);
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        setLightIcon(tab.id);
    });
}
