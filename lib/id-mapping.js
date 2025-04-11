const axios = require("axios");
const LRU = require("lru-cache");
const {
  getFromDatabase,
  cacheToDatabase,
  getExternalIdFromDb,
  cacheExternalIdToDb,
} = require("./sqlite"); // Add new DB functions

// Cache for source:id -> anilistId
const anilistIdCache = new LRU({
  max: 10000,
  ttl: 24 * 60 * 60 * 1000, // Cache for 1 day
});

// Cache for anilistId -> externalIds { tvdb, tmdb }
const externalIdCache = new LRU({
  max: 5000,
  ttl: 7 * 24 * 60 * 60 * 1000, // Cache for 1 week (less likely to change)
});

// Get Anilist ID from other sources (Kitsu, IMDB)
async function getAnilistId(id, source) {
  const cacheKey = `${source}:${id}`;

  if (anilistIdCache.has(cacheKey)) {
    return anilistIdCache.get(cacheKey);
  }

  try {
    const cachedId = await getFromDatabase(id, source);
    if (cachedId) {
      anilistIdCache.set(cacheKey, cachedId);
      console.log(`[Cache] DB Hit for ${cacheKey} -> anilist:${cachedId}`);
      return cachedId;
    }
  } catch (dbError) {
    console.error(`Database read error for ${cacheKey}:`, dbError);
  }

  let anilistId = null;

  // Prioritize Kitsu mapping API if source is Kitsu
  if (source === "kitsu") {
    anilistId = await fetchAnilistIdFromKitsu(id);
    if (anilistId) {
      console.log(
        `[API] Kitsu Mapping API success for ${cacheKey} -> anilist:${anilistId}`
      );
    } else {
      console.log(
        `[API] Kitsu Mapping API failed for ${cacheKey}, trying ARM.`
      );
    }
  }

  // Fallback or primary method using ARM API
  if (!anilistId) {
    anilistId = await fetchAnilistIdFromArm(id, source);
    if (anilistId) {
      console.log(
        `[API] ARM API success for ${cacheKey} -> anilist:${anilistId}`
      );
    } else {
      console.log(`[API] ARM API failed for ${cacheKey}`);
    }
  }

  if (anilistId) {
    anilistIdCache.set(cacheKey, anilistId);
    try {
      await cacheToDatabase(anilistId, id, source);
      console.log(
        `[Cache] DB Write success for ${cacheKey} -> anilist:${anilistId}`
      );
    } catch (dbError) {
      console.error(
        `Database write error for anilistId ${anilistId}:`,
        dbError
      );
    }
  }

  return anilistId;
}

// Get external IDs (TVDB, TMDB) from Anilist ID
async function getExternalId(anilistId, targetSource) {
  const cacheKey = `anilist:${anilistId}:${targetSource}`;

  if (externalIdCache.has(cacheKey)) {
    return externalIdCache.get(cacheKey);
  }

  try {
    const cachedId = await getExternalIdFromDb(anilistId, targetSource);
    if (cachedId) {
      externalIdCache.set(cacheKey, cachedId);
      console.log(
        `[Cache] DB Hit for anilist:${anilistId} -> ${targetSource}:${cachedId}`
      );
      return cachedId;
    }
  } catch (dbError) {
    console.error(
      `Database read error for external ID anilist:${anilistId} -> ${targetSource}:`,
      dbError
    );
  }

  console.log(
    `[API] Fetching external IDs for anilist:${anilistId} including ${targetSource} from ARM.`
  );
  let externalId = null;
  try {
    // Use ARM API for reverse lookup
    // Include both potential targets to cache them together if possible
    const response = await axios.get(
      `https://arm.haglund.dev/api/v2/ids?source=anilist&id=${anilistId}&include=thetvdb,themoviedb`,
      { timeout: 5000 } // Add timeout
    );

    if (response.data) {
      const tvdbId = response.data.thetvdb;
      const tmdbId = response.data.themoviedb;

      // Cache both results if found
      if (tvdbId) {
        externalIdCache.set(`anilist:${anilistId}:thetvdb`, tvdbId);
        await cacheExternalIdToDb(anilistId, tvdbId, "thetvdb");
      }
      if (tmdbId) {
        externalIdCache.set(`anilist:${anilistId}:themoviedb`, tmdbId);
        await cacheExternalIdToDb(anilistId, tmdbId, "themoviedb");
      }

      // Return the specifically requested one
      externalId = response.data[targetSource];
      if (externalId) {
        console.log(
          `[API] ARM API success for anilist:${anilistId} -> ${targetSource}:${externalId}`
        );
      } else {
        console.log(
          `[API] ARM API did not return ${targetSource} ID for anilist:${anilistId}`
        );
      }
    } else {
      console.log(`[API] ARM API returned no data for anilist:${anilistId}`);
    }
  } catch (err) {
    if (err.response) {
      console.error(
        `[API] ARM API error fetching external ID for anilist:${anilistId}: ${err.response.status} ${err.response.statusText}`
      );
    } else {
      console.error(
        `[API] ARM API request error fetching external ID for anilist:${anilistId}:`,
        err.message
      );
    }
    return null;
  }

  return externalId;
}

async function fetchAnilistIdFromKitsu(id) {
  try {
    const response = await axios.get(
      `https://kitsu.io/api/edge/anime/${id}/mappings`,
      { timeout: 5000 }
    );
    const mapping = response.data?.data?.find(
      (x) => x.attributes.externalSite === "anilist/anime"
    );
    const anilistId = mapping?.attributes.externalId;
    return anilistId ? parseInt(anilistId) : null;
  } catch (err) {
    if (err.response) {
      console.error(
        `[API] Kitsu API error fetching mapping for kitsu:${id}: ${err.response.status} ${err.response.statusText}`
      );
    } else {
      console.error(
        `[API] Kitsu API request error fetching mapping for kitsu:${id}:`,
        err.message
      );
    }
    return null;
  }
}

async function fetchAnilistIdFromArm(id, source) {
  // Map addon source names to ARM source names if different
  const armSource = source === "imdb" ? "imdb" : source;

  try {
    const response = await axios.get(
      `https://arm.haglund.dev/api/v2/ids?source=${armSource}&id=${id}&include=anilist`,
      { timeout: 5000 }
    );
    const anilistId = response.data?.anilist;
    return anilistId ? parseInt(anilistId) : null;
  } catch (err) {
    if (err.response) {
      console.error(
        `[API] ARM API error fetching anilist ID for ${source}:${id}: ${err.response.status} ${err.response.statusText}`
      );
    } else {
      console.error(
        `[API] ARM API request error fetching anilist ID for ${source}:${id}:`,
        err.message
      );
    }
    return null;
  }
}

module.exports = {
  getAnilistId,
  getExternalId,
};
