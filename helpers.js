var settings = 
{
    get maxDepth() { return localStorage["max-crawl-depth"]!=null?localStorage["max-crawl-depth"]:2; },
    set maxDepth(val) { localStorage['max-crawl-depth'] = val; },
    get root() { return localStorage["root"]!=null?localStorage["root"]:""; },
    set root(val) { localStorage['root'] = val; },
}

function startsWith(s, str){
    return (s.indexOf(str) === 0);
}

function getAllLinksOnPage(page)
{
    var links = new Array();    
    $(page).find('[src]').each(function(){ links.push($(this).attr('src')); }); 
    $(page).find('[href]').each(function(){ links.push($(this).attr('href')) });    
    return links;
}

function isInArr(arr,val)
{
    for (var i in arr)
    {
        if(arr[i]==val){ return true; }
    }
    return false;
}