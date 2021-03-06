const cheerio = require( "cheerio" );
const fs = require( "mz/fs" );
const path = require( "path" );
const dirExists = require( "directory-exists" );
const mkdir = require( "make-dir" );
const Jszip = require( "jszip" );
const strpad = require( "strpad" );
const log = require( "./log" );

/**
 * Includes general purpose functions,
 * implemented into the download process in download.js
 */

const providers = require( "./providers" );

const timeout = {
  counter: 10,
  msg    : "",
  /**
   * Increase counter, add msg, return whenever to continue or not
   */
  add( msg ) {
    if ( !this.counter ) {
      if ( this.msg.match( "Connection Error: Retrieving the last page from the url" ) ) {
        throw new Error( this.msg ); // Set pagesTotal to 0
      } else {
        log.prompt( this.msg );
        process.exit(); // eslint-disable-line unicorn/no-process-exit
      }
    }

    this.counter--;
    this.msg = msg;
  },
  /**
   * Reset counter after successful execution
   */
  reset() {
    this.counter = 10;
  },
};

/**
 * Parse image source url from given site
 * @returns {(string|Error)} - Returns img source url if not invalid page or chapter
 */
function getImgSrcIfValid( url = this.url, provider = this.provider ) {
  const providerLib = providers.getLib( provider );

  return providerLib.ajax( url )
    .then( data => {
      const imgSrc = providerLib.getImgSrc( data );

      return imgSrc || new Error( `Invalid: ${url}` );
    } )
    .catch( err => new Error( `Invalid: ${url}` ) );
}

/**
 * Parse data from given url
 * @returns {object} - Incomplete manga object with name, chapter, page, provider
 */
function parseFromUrl( url, passedProvider = null ) {
  let [ , provider, name, chapter = 1, page = 1 ] =
    String( url ).match( /(?:https?:\/\/)?(?:www.)?((?:mangareader.net)|(?:readmng.com)|(?:goodmanga.net)|(?:mangapanda.com)|(?:mangainn.net)|(?:mangalife.us\/read-online))?(?:\/)?([^/]+)\/?(?:chapter\/)?(\d+)?\/?(\d+)?/i );
  /** Matches:
   * https://www.mangareader.net/shingeki-no-kyojin/103/39
   * https://www.readmng.com/platinum-end/19/2
   * http://www.goodmanga.net/dr.-stone/chapter/55
   * https://www.mangapanda.com/shingeki-no-kyojin/103/39
   * http://www.mangainn.net/ao-no-exorcist/100/1
   */

  provider = provider ? provider.split( "." )[0] : null;
  provider = passedProvider && !provider ? passedProvider : provider;

  if ( provider === "mangalife" && String( name ).match( /\.html/ ) ) {
    [ , , name, chapter = 1, page = 1 ] =
      String( url ).match( /(?:https?:\/\/)?(?:www.)?(mangalife.us\/read-online)?(?:\/)?(.+?(?=-chapter-))-chapter-(\d+)-page-(\d+)?.html/ );
    /** Matches:
     * http://mangalife.us/read-online/Platinum-End-chapter-31-page-1.html
     */
  }

  name = name.toLowerCase();

  return {
    name,
    provider,
    chapter: Number( chapter ),
    page   : Number( page ),
  };
}

/**
 * Create url from given inputs
 */
const createUrl = ( provider, name, chapter, page = 1 ) => {
  provider = `${provider}.${providers.extensions[provider]}`;

  if ( provider === "goodmanga.net" )
    return `https://www.${provider}/${name}/chapter/${chapter}/${page}`;
  if ( provider === "mangalife.us" )
    return `https://${provider}/read-online/${name}-chapter-${chapter}-page-${page}.html`;

  return `https://www.${provider}/${name}/${chapter}/${page}`;
};

/**
 * Create manga object from given url
 * @returns {object} - Manga object containing name, chapter, page, siteUrl, imgSrc, outputPath, provider
 */
function createManga( url, outputPath, provider ) {
  const manga = parseFromUrl( url, provider );
  manga.chapter = manga.chapter || 1;
  manga.page = manga.page || 1;

  return Object.assign( manga, {
    outputPath,
    url      : createUrl( manga.provider, manga.name, manga.chapter, manga.page ),
    getImgSrc: getImgSrcIfValid,
  } );
}

/**
 * Chapter + 1, regenerate url, return newly created new manga object
 */
function increase( manga ) {
  manga.chapter += 1;
  manga.page = 1;

  manga.url = createUrl( manga.provider, manga.name, manga.chapter, manga.page );

  return getImgSrcIfValid( manga.url, manga.provider )
    .then( imgSrc => {
      manga.imgSrc = imgSrc;
      return manga.imgSrc instanceof Error ? null : manga;
    } );
}

/**
 * Downloads the given image and returns its buffer
 */
const downloadImg = ( manga ) => {
  const providerLib = providers.getLib( manga.provider );

  return manga.getImgSrc()
    .then( imgSrc => providerLib.getImgBuffer( imgSrc )
      .then( buffer => { timeout.reset(); return buffer; } )
      .catch( err => {
        manga.getImgSrc().then( src => timeout.add( `Connection Error: Downloading image from the url '${src}'` ) );
        return downloadImg( manga );
      } )
    );
};

/**
 * Create cbz file from an array of buffers representing the pages of the chapter
 * @param {buffer[]} buffers
 */
async function createZip( buffers, name, chapter, outputPath ) {
  const zip = new Jszip();

  buffers.sort( ( a, b ) => a.n - b.n );

  const outputPathExists = await dirExists( outputPath );
  if ( !outputPathExists )
    mkdir( outputPath );

  outputPath = path.resolve( outputPath, `${name}-${strpad.left( chapter, 3, 0 )}.cbz` );

  let i = 1;
  for ( const buffer of buffers ) {
    await zip.file( `${name}-${chapter}-${i}.jpg`, buffer.buff, { binary: true } );
    i++;
  }

  return zip.generateAsync( { type: "uint8array" } )
    .then( data => fs.writeFile( outputPath, data, { encoding: null } )
      .then( () => outputPath )
      .catch( err => err ) );
}

function handle404( err, name, provider ) {
  if ( err.response.status === 404 )
    log.prompt( `The manga '${name}' doesn't exist/doesn't have chapters on '${provider}'` );
  process.exit(); // eslint-disable-line unicorn/no-process-exit
}

const getLastChapter = async ( name, provider ) => {
  const providerLib = providers.getLib( provider );

  let url = `http://www.${provider}.${providers.extensions[provider]}/${name}`;
  const numInName = name.match( /\d/ ); // else null

  if ( provider === "goodmanga" )
    url = await providerLib.getNameUrl( name ).catch( err => handle404( err, name, provider ) );
  if ( provider === "mangalife" )
    url = providerLib.getNameUrl( name );

  return Promise.resolve( url )
    .then( url => providerLib.ajax( url )
      .catch( err => handle404( err, name, provider ) )
    )
    .then( html => {
      const lastChapter = providerLib.getLastChapter( html, numInName );
      return Number( lastChapter );
    } )
    .then( chapter => { timeout.reset(); return chapter; } )
    .catch( err => {
      timeout.add( `Connection Error: Retrieving the last chapter from the url '${url}'` );
      return getLastChapter( name, provider );
    } );
};

const getLastPage = ( url, provider ) => {
  const providerLib = providers.getLib( provider );

  return providerLib.ajax( url )
    .then( html => {
      const providerLib = providers.getLib( provider );
      const lastPage = providerLib.getLastPage( html );
      return Number( lastPage );
    } )
    .then( page => { timeout.reset(); return page; } )
    .catch( err => {
      timeout.add( `Connection Error: Retrieving the last page from the url '${url}'` );
      return getLastPage( url, provider );
    } );
};

module.exports = {
  getImgSrcIfValid,
  downloadImg,
  createUrl,
  createManga,
  parseFromUrl,
  increase,
  createZip,
  getLastChapter,
  getLastPage,
};
