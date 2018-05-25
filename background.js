var tabs = ["Queued","Crawling","Crawled","Errors","Cookies"];
var allPages = {};
var allCookiesSeen = {};
var allCookies = [];
var crawlStartURL = settings.root;
var startingPage = {};
var appState = "stopped";

function beginCrawl(url)
{   
    reset();    
    appState = "crawling";
    settings.root = url;
    crawlStartURL = url;    
    allPages[url] = {url:url, state:"queued", depth:0};
    startingPage = allPages[url];
    crawlMore();
}

function tabQuery(query) {
    return new Promise((resolve, reject) => {
         chrome.tabs.query(query, resolve);
    });
}

function getCookies() {
    return new Promise((resolve, reject) => {
        chrome.cookies.getAll({}, resolve);
    });
}

// Working around slightly annoying tab update API: you can't
// remove listeners, and you can't just listen to one tab
_onTabUpdated = (tabId, info) => {
    onTabUpdated.forEach((func) => {
        func(tabId, info);
    });
}
onTabUpdated = []
chrome.tabs.onUpdated.addListener(_onTabUpdated);
function onTabStatusComplete(tabId) {
    return new Promise((resolve, reject) => {
        var newOnTabUpdated = (updatedTabId, info) => {
            if (updatedTabId == tabId && info.status == 'complete') {
                resolve();
                onTabUpdated.splice(newLength - 1, 1);
            }
        }
        var newLength = onTabUpdated.push(newOnTabUpdated);
    });
}

function sendMessage(tabId, message) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, resolve);
    });
}

function crawlPage(page)
{
    page.state = "crawling";
    
    console.log("Starting Crawl --> "+JSON.stringify(page));

    tabQuery({active: true, currentWindow: true}).then((tabs) => {
        chrome.tabs.update(tabs[0].id, {
            url: page.url
        });
        return onTabStatusComplete(tabs[0].id).then(() => {
            return tabs[0].id;
        });
    }).then((tabId) => {
        return sendMessage(tabId, {text: 'get_links'});
    }).then((links) => {
        console.log('error',  chrome.runtime.lastError);
        return getCookies().then((cookies) => {
            return {
                cookies: cookies,
                links: links.links
            };
       });
    }).then(cookiesLinks => {
        return onCrawlPageLoaded(page, cookiesLinks.links, cookiesLinks.cookies);
    }).then(() => {
        crawlMore();
    });
}

function onCrawlPageLoaded(page, links, cookies)
{   
    // Loop through each
    var newLinks = links.filter(function(linkURL) {
        return startsWith(linkURL, startingPage.url) && !allPages[linkURL];
    })
    newLinks.forEach(function(linkURL) {  
        allPages[linkURL] = {
            depth: page.depth+1,
            url: linkURL,
            state: page.depth == settings.maxDepth ? "max_depth" : "queued"
        }
    });
    
    // Debugging is good
    console.log("Page Crawled --> "+JSON.stringify({page:page, counts:newLinks.length}));
    
    // This page is crawled
    allPages[page.url].state = "crawled";  

    function cookieKey(cookie) {
        return  '___DOMAIN___' + cookie.domain + "___NAME___" + cookie.name + "___PATH___" + cookie.path;
    }
    var newCookies = cookies.filter(function(cookie) {
        return !(cookieKey(cookie) in allCookiesSeen)
    });
    newCookies.forEach(function(cookie) {
        allCookiesSeen[cookieKey(cookie)] = true
        allCookies.push({
            domain: cookie.domain,
            path: cookie.path,
            name: cookie.name,
            expirationDate: cookie.session ? 'session' : moment.unix(cookie.expirationDate).fromNow(true),
            firstSeen: page.url
        })
    });
}

function crawlMore() 
{   
    if(appState!="crawling"){ return; }
    while(getURLsInTab("Crawling").length<1 && getURLsInTab("Queued").length>0)
    {
        crawlPage(getURLsInTab("Queued")[0]);
    }
}

function getURLsInTab(tab)
{
    var tabUrls = [];   
    for(var ref in allPages) 
    {
        var o = allPages[ref];
        if(tab=="Queued" && o.state=="queued" && !o.isFile){ tabUrls.push(o); }
        else if(tab=="Crawling" && o.state=="crawling"){ tabUrls.push(o); }
        else if(tab=="Crawled" && o.state=="crawled"){ tabUrls.push(o); }
        else if(tab=="Errors" && o.state=="error"){ tabUrls.push(o); }  
    };      
    return tabUrls;
}

function reset() 
{
    allPages = {};  
    allCookiesSeen = {};
    allCookies = [];
}