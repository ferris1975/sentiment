// pull in libraries
const util = require('util');
const express = require('express');
const request = require('request');
const Sentiment = require('sentiment');
const moment = require('moment');
const requestPromise = require('request-promise');
const Joi = require('joi');
const NewsAPI = require('newsapi');
const MongoClient = require('mongodb').MongoClient;
const Coinmarketcap = require('node-coinmarketcap-api');
const collector = require('./collector');
const extractor = require('node-article-extractor');

// load environment vars
require('dotenv').config();

// instances
const coinmarketcap = new Coinmarketcap();
const newsapi = new NewsAPI(process.env.NEWS_API_KEY);

// coins in global scope
var coins = [];

// schedule data collector 
exports.collectData = function collectData() {

    // get coin listing from coinmarketcap
    loadCoins().then((input) => {

        // store coins in global scope
        coins = input;
        coins.sort((a,b) => {
            if(a.name.split(" ").length > b.name.split(" ").length) return -1;
            else return 1;
        });

        // get articles from newsapi
        return loadArticles(input);
    }).then((input) => {
        // process all articles
        return calculateSentiment(input, coins);
    }).then((input) => {
        // wait 4 hours and restart
        setTimeout(() => {collectData()}, 1000 * 3600 * 4);
        console.log("Collecting again in 4 hours ...")
    }).catch((err) => {
        console.log(err);
    });
 
}

// schedule rate updates
exports.updateRates = function updateRates() {

    // load rates
    loadCoins().then((input) => {
        return loadRates(input);
    }).then((input) => {
        // wait 10 minutes seconds and restart
        setTimeout(() => {updateRates()}, 1000 * 60 * 10);
        console.log("Updating rates in 10 minutes ...")
    }).catch((err) => {
        console.log(err);
    });

}

// get articles from db
exports.getArticles = function getArticles() {
    return new Promise((resolve, reject) => {
        var url = process.env.MONGODB_URL;
        MongoClient.connect(url, { useNewUrlParser: true }, (err, db) => {
            if (err) reject(err);
            var dbo = db.db(process.env.MONGODB_NAME);
            dbo.collection("articles_dev").find({"timestamp" : {"$gte": moment().add(-4, 'week').format('YYYY-MM-DD')}}).sort([['_id', -1]]).toArray((err, result) => {
                if (err) reject(err);
                db.close();
                resolve(result);
            });
        });
    });    
}

// cache objects
var rates = {};

// get rates from cache
exports.getRates = function getRates() {
    return rates;
}

// get distinct coin list
function getCoins() {
    return new Promise((resolve, reject) => {
        var url = process.env.MONGODB_URL;
        MongoClient.connect(url, { useNewUrlParser: true }, (err, db) => {
            if (err) reject(err);
            var dbo = db.db(process.env.MONGODB_NAME);
            dbo.collection("articles_dev").distinct("coin", (err, result) => {
                if (err) reject(err);
                db.close();
                resolve(result);
            });
        });
    });    
}

// load market data
function loadRates(coins) {
    if(coins.length > 0) {
        var coin = coins.pop();
        var past,current;
        return requestPromise("https://min-api.cryptocompare.com/data/pricehistorical?fsym=" + coin.symbol + "&tsyms=USD&ts=" + moment().add(-4, 'week').unix()).then((input) => {
            if(JSON.parse(input)[coin.symbol]) past = JSON.parse(input)[coin.symbol].USD;
            return requestPromise("https://min-api.cryptocompare.com/data/price?fsym=" + coin.symbol + "&tsyms=USD");
        }).then((input) => {
            return new Promise((resolve, reject) => {
                current = JSON.parse(input).USD;
                rates[coin.name] = {"current": current, "past": past};
                console.log("Loaded rates for " + coin.name + " -> " + JSON.stringify(rates[coin.name]));
                // sleep 1 second
                setTimeout(resolve, 1000);
            });
        }).then(() => {
            if(coins.length > 0) {
                return loadRates(coins);
            } else {
                console.log("Processing rates finished!");
                return;
            }
        }).catch((err) => {
            console.log(err);
        });
    }      
}

// load articles from newsapi
function loadArticles(coins) {
    return new Promise((resolve, reject) => {
        var result = [];
        coins.forEach((coin) => {
            result.push(       
                new Promise((resolve, reject) => {
                    newsapi.v2.everything({
                        q: '"' + coin.name + '"',
                        language: 'en',
                        sources: 'crypto-coins-news',
                        pageSize: 100,
                        from: moment().add(-1, 'week').format('YYYY-MM-DD'),
                    }).then((response) => {
                        var articles = response.articles;
                        articles.forEach((article) => {
                            article.coin = coin.name;
                            article.symbol = coin.symbol;
                        });
                        resolve(articles);
                    }).catch((err) => {
                        reject(err);
                    });
                })
            );
        }); 
        resolve(Promise.all(result));
    }).then((input) => {
        // merge arrays of articles
        var articles = [];
        input.forEach((item) => {
            articles = articles.concat(item);
        });
        console.log("Found " + articles.length + " articles ...");
        return articles;
    });
}

// calculate sentiment for each article and store in db
function calculateSentiment(articles) {
    if(articles.length > 0) {
        var article = articles.pop();        
        return new Promise((resolve, reject) => {
            // lookup article
            var url = process.env.MONGODB_URL;
            MongoClient.connect(url, { useNewUrlParser: true }, (err, db) => {
                if (err) reject(err);
                var dbo = db.db(process.env.MONGODB_NAME);
                dbo.collection("articles_dev").findOne({url: article.url}, (err, res) => {
                    if (err) reject(err);
                    db.close();
                    if (!res) resolve(false);
                    else resolve(true);
                });
            });
        }).then((found) => {        
            if(!found) {
                // calculate sentiment
                return new Promise((resolve, reject) => {
                    request(article.url, (err, res, body) => {
                        var sentiment = new Sentiment();
                        var score = "n/a";
                        var comparative = "n/a";
                        if(!err) {
                            var content = extractor(body);
                            var result = sentiment.analyze(content.text);
                            var coinWeighting = countCoinOccurences(content.text, coins);
                            score = result.score;
                            comparative = result.comparative;
                        } else {
                            // no sentiment calculated, but proceed
                            console.log(err);
                        }
                        resolve({'timestamp':article.publishedAt,'coins':coinWeighting,'score':score,'comparative':comparative,'title':article.title,'url':article.url,'snippet':article.description,'source':article.source.id});          
                    });
                });
            } else {
                return null;
            }
        }).then((newItem) => {
            if(newItem) {
                // store new item
                return new Promise((resolve, reject) => {
                    var url = process.env.MONGODB_URL;
                    MongoClient.connect(url, { useNewUrlParser: true }, (err, db) => {
                        if (err) reject(err);
                        var dbo = db.db(process.env.MONGODB_NAME);
                        dbo.collection("articles_dev").updateOne({url: newItem.url,coin: newItem.coin}, {$set:newItem}, {upsert: true}, (err, res) =>{
                            if (err) {
                                console.log(err);
                                reject(err);
                            }
                            console.log((res.result.upserted?"Added - ":"Skipped - ") + newItem.url + " article -> (query: " + article.coin + ", coins: " + JSON.stringify(newItem.coins) + ", score: " + newItem.score + ")");
                            db.close();
                            resolve(newItem);
                        });
                    });
                });
            } else {
                return;
            }
        }).then((item) => {
            if(articles.length%50==0) console.log("Processing articles -> " + articles.length + " to go ...");
            if(articles.length > 0) {
                return calculateSentiment(articles);
            } else {
                console.log("Processing articles finished!");
                return;
            }
        });  
    } else {
        return result;
    }
    
}

// delete coin entries from db
function deleteCoin(coin) {
    return new Promise((resolve, reject) => {
        var url = process.env.MONGODB_URL;
        MongoClient.connect(url, { useNewUrlParser: true }, (err, db) => {
            if (err) throw err;
            var dbo = db.db(process.env.MONGODB_NAME);
            var query = { coin: coin };
            dbo.collection("articles").deleteMany(query, (err, obj) => {
                if (err) throw err;
                console.log(obj.result.n + " document(s) deleted");
                db.close();
            });
        });   
    });
}

function loadCoins() {
    return coinmarketcap.ticker("", "", 25).then((input) => {
        var result = [];
        input.forEach((item) => {
            result.push({"name": item.name.toLowerCase(), "symbol":item.symbol});
        });
        console.log("Fetched top 25 coins -> " + JSON.stringify(result));
        return result;
    });
}

exports.loadCoins = loadCoins;

function countCoinOccurences(text, coins = []) {
    var result = {};
    coins.forEach((coin) => {
        var count = 0;
        var nameRegex = new RegExp(coin.name, "gi");
        var nameCount = (text.match(nameRegex) || []).length;
        if(nameCount) {
            text =  text.replace(nameRegex, "___");
        }
        var symbolRegex = new RegExp(coin.symbol, "g");                
        var symbolCount = (text.match(symbolRegex) || []).length;
        if(nameCount > symbolCount) {
            count = nameCount;
        } else {
            count = symbolCount;
        }
        if(count) result[coin.symbol] = count;
    });
    return result;
}