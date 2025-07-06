const express = require('express');
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const NodeCache = require('node-cache');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');

// Constants
const IPTV_CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const IPTV_STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';
const M3U_PLAYLIST_URL = process.env.M3U_PLAYLIST_URL || '';  // NEW: M3U playlist URL
const PORT = process.env.PORT || 3000;
const FETCH_INTERVAL = parseInt(process.env.FETCH_INTERVAL) || 86400000; // 1 day
const PROXY_URL = process.env.PROXY_URL || '';
const FETCH_TIMEOUT = parseInt(process.env.FETCH_TIMEOUT) || 10000;

// Config (same as before)
const config = {
    includeLanguages: process.env.INCLUDE_LANGUAGES ? process.env.INCLUDE_LANGUAGES.split(',') : [],
    includeCountries: process.env.INCLUDE_COUNTRIES ? process.env.INCLUDE_COUNTRIES.split(',') : ['GR'],
    excludeLanguages: process.env.EXCLUDE_LANGUAGES ? process.env.EXCLUDE_LANGUAGES.split(',') : [],
    excludeCountries: process.env.EXCLUDE_COUNTRIES ? process.env.EXCLUDE_COUNTRIES.split(',') : [],
    excludeCategories: process.env.EXCLUDE_CATEGORIES ? process.env.EXCLUDE_CATEGORIES.split(',') : [],
};

// Express app setup
const app = express();
app.use(express.json());

// Cache setup
const cache = new NodeCache({ stdTTL: 0 });

// Addon Manifest (unchanged)
const manifest = {
    id: 'org.iptv',
    name: 'IPTV Addon',
    version: '0.0.3',
    description: `Watch live TV from ${config.includeCountries.join(', ')}`,
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    catalogs: config.includeCountries.map(country => ({
        type: 'tv',
        id: `iptv-channels-${country}`,
        name: `IPTV - ${country}`,
        extra: [
            {
                name: 'genre',
                isRequired: false,
                options: [
                    "animation", "business", "classic", "comedy", "cooking", "culture", "documentary", "education",
                    "entertainment", "family", "kids", "legislative", "lifestyle", "movies", "music", "general",
                    "religious", "news", "outdoor", "relax", "series", "science", "shop", "sports", "travel", "weather", "xxx", "auto"
                ]
            }
        ],
    })),
    idPrefixes: ['iptv-'],
    behaviorHints: { configurable: false, configurationRequired: false },
    logo: "https://dl.strem.io/addon-logo.png",
    icon: "https://dl.strem.io/addon-logo.png",
    background: "https://dl.strem.io/addon-background.jpg",
};

const addon = new addonBuilder(manifest);

// Helper: Parse M3U playlist text
function parseM3U(data) {
    const lines = data.split(/\r?\n/);
    const channels = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('#EXTINF')) {
            const infoLine = lines[i];
            const urlLine = lines[i + 1] || '';

            // Extract attributes from EXTINF line
            const nameMatch = infoLine.match(/,(.*)$/);
            const name = nameMatch ? nameMatch[1].trim() : 'Unknown';

            const tvgIdMatch = infoLine.match(/tvg-id="([^"]*)"/);
            const tvgId = tvgIdMatch ? tvgIdMatch[1].trim() : null;

            const logoMatch = infoLine.match(/tvg-logo="([^"]*)"/);
            const logo = logoMatch ? logoMatch[1].trim() : null;

            const groupMatch = infoLine.match(/group-title="([^"]*)"/);
            const group = groupMatch ? groupMatch[1].trim() : null;

            channels.push({
                id: tvgId || name.toLowerCase().replace(/\W+/g, '-'),
                name,
                logo,
                categories: group ? [group.toLowerCase()] : [],
                country: '',          // M3U doesn’t provide country, set empty or parse if you want
                languages: [],        // No language info in M3U, can be empty or default
                streamUrl: urlLine.trim()
            });
            i++; // skip next line as it's stream url
        }
    }
    return channels;
}

// Convert parsed M3U channel to Meta for Stremio
const m3uToMeta = (channel) => ({
    id: `iptv-${channel.id}`,
    name: channel.name,
    type: 'tv',
    genres: [...(channel.categories || [])],
    poster: channel.logo,
    posterShape: 'square',
    background: channel.logo || null,
    logo: channel.logo || null,
});

// Fetch M3U playlist and parse
const getM3UChannels = async () => {
    if (!M3U_PLAYLIST_URL) return [];
    if (cache.has('m3uChannels')) {
        return cache.get('m3uChannels');
    }
    try {
        const response = await axios.get(M3U_PLAYLIST_URL, { timeout: FETCH_TIMEOUT });
        const channels = parseM3U(response.data);
        cache.set('m3uChannels', channels);
        return channels;
    } catch (err) {
        console.error('Failed to fetch or parse M3U playlist:', err.message);
        return [];
    }
};

// Fetch IPTV JSON data (unchanged)
const getChannels = async () => {
    console.log("Downloading channels");
    try {
        const channelsResponse = await axios.get(IPTV_CHANNELS_URL, { timeout: FETCH_TIMEOUT });
        console.log("Finished downloading channels");
        return channelsResponse.data;
    } catch (error) {
        console.error('Error fetching channels:', error);
        if (cache.has('channels')) {
            console.log('Serving channels from cache');
            return cache.get('channels');
        }
        return [];
    }
};

const getStreamInfo = async () => {
    if (!cache.has('streams')) {
        console.log("Downloading streams data");
        try {
            const streamsResponse = await axios.get(IPTV_STREAMS_URL, { timeout: FETCH_TIMEOUT });
            cache.set('streams', streamsResponse.data);
        } catch (error) {
            console.error('Error fetching streams:', error);
            return [];
        }
    }
    return cache.get('streams');
};

// Verify stream URL (unchanged)
const verifyStreamURL = async (url, userAgent, httpReferrer) => {
    const cachedResult = cache.get(url);
    if (cachedResult !== undefined) {
        return cachedResult;
    }

    const effectiveUserAgent = userAgent || 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 DMOST/2.0.0 (; LGE; webOSTV; WEBOS6.3.2 03.34.95; W6_lm21a;)';
    const effectiveReferer = httpReferrer || '';

    let axiosConfig = {
        timeout: FETCH_TIMEOUT,
        headers: {
            'User-Agent': effectiveUserAgent,
            'Accept': '*/*',
            'Referer': effectiveReferer
        }
    };

    if (PROXY_URL) {
        if (PROXY_URL.startsWith('socks')) {
            axiosConfig.httpsAgent = new SocksProxyAgent(PROXY_URL);
        } else {
            axiosConfig.httpsAgent = new HttpProxyAgent(PROXY_URL);
        }
    }

    try {
        const response = await axios.head(url, axiosConfig);
        const result = response.status === 200;
        cache.set(url, result);
        return result;
    } catch (error) {
        cache.set(url, false);
        return false;
    }
};

// Get all channel info (merged JSON + M3U)
const getAllInfo = async () => {
    // Fetch JSON IPTV data
    const streams = await getStreamInfo();
    const channels = await getChannels();

    // Fetch M3U playlist channels
    const m3uChannels = await getM3UChannels();

    // Map JSON streams by channel id
    const streamMap = new Map(streams.map(stream => [stream.channel, stream]));

    // Filter JSON channels
    const filteredJsonChannels = channels.filter((channel) => {
        if (config.includeCountries.length > 0 && !config.includeCountries.includes(channel.country)) return false;
        if (config.excludeCountries.length > 0 && config.excludeCountries.includes(channel.country)) return false;
        if (config.includeLanguages.length > 0 && !channel.languages.some(lang => config.includeLanguages.includes(lang))) return false;
        if (config.excludeLanguages.length > 0 && channel.languages.some(lang => config.excludeLanguages.includes(lang))) return false;
        if (config.excludeCategories.length > 0 && channel.categories.some(cat => config.excludeCategories.includes(cat))) return false;
        return true;
    });

    // Build final combined list: M3U channels + filtered JSON channels (remap JSON channels with stream info)
    const jsonChannelsWithStreams = filteredJsonChannels.map(channel => {
        const stream = streamMap.get(channel.id);
        return {
            id: channel.id,
            name: channel.name,
            logo: channel.logo,
            categories: channel.categories,
            country: channel.country,
            languages: channel.languages,
            streamUrl: stream ? stream.url : null,
        };
    }).filter(c => c.streamUrl);

    // Combine and dedupe by id (M3U may overlap with JSON channels)
    const allChannelsMap = new Map();
    [...m3uChannels, ...jsonChannelsWithStreams].forEach(channel => {
        allChannelsMap.set(channel.id, channel);
    });

    return Array.from(allChannelsMap.values());
};

// Catalog handler
addon.defineCatalogHandler(async ({ type, id, extra }) => {
    if (type !== 'tv') return { metas: [] };

    const allChannels = await getAllInfo();

    let filtered = allChannels;

    // Filter by genre if requested
    if (extra && extra.genre) {
        filtered = filtered.filter(c => c.categories && c.categories.includes(extra.genre.toLowerCase()));
    }

    // Filter by country from catalog id (e.g. iptv-channels-GR)
    if (id && id.startsWith('iptv-channels-')) {
        const countryCode = id.split('-').pop().toUpperCase();
        filtered = filtered.filter(c => c.country.toUpperCase() === countryCode);
    }

    // Convert to Stremio meta format
    const metas = filtered.map(m3uToMeta);

    return { metas };
});

// Meta handler
addon.defineMetaHandler(async ({ type, id }) => {
    if (!id.startsWith('iptv-')) return null;
    const channelId = id.substring(5);

    const allChannels = await getAllInfo();
    const channel = allChannels.find(c => c.id === channelId);
    if (!channel) return null;

    return {
        id,
        type: 'tv',
        name: channel.name,
        genres: channel.categories,
        poster: channel.logo,
        background: channel.logo,
        streams: [
            {
                url: channel.streamUrl,
                title: channel.name,
            }
        ],
    };
});

// Stream handler
addon.defineStreamHandler(async ({ type, id, extra }) => {
    if (!id.startsWith('iptv-')) return { streams: [] };
    const channelId = id.substring(5);

    const allChannels = await getAllInfo();
    const channel = allChannels.find(c => c.id === channelId);
    if (!channel || !channel.streamUrl) return { streams: [] };

    const isValid = await verifyStreamURL(channel.streamUrl, extra?.userAgent, extra?.httpReferrer);
    if (!isValid) return { streams: [] };

    return {
        streams: [
            {
                title: channel.name,
                url: channel.streamUrl,
                isRemote: true,
            }
        ]
    };
});

app.use('/', addon.getInterface());
app.listen(PORT, () => {
    console.log(`IPTV Addon listening on port ${PORT}`);
});
