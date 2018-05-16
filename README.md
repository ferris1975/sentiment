# crypto sentiment

Alpha version of a tiny app that does the following:

1. Get latest news articles from crypto-news via newsapi.org
2. For each article
  * Get HTML from source URL
  * Extract plain text (strip layout, adds, etc)
  * Calculate sentiment based on AFINN words
3. Return HTML with color coded ```<div>``` elements (red = negative, green = positive sentiment)

Create a file '''.env''' in the directory with the following content:

`NEWS_API_KEY=[your NewsAPI key]` (get your key at https://newsapi.org/)

`MONGODB_URL=mongodb://[your db user]:[your db password]@[your db URL]` 

`MONGODB_NAME=[your db name]` 

 
