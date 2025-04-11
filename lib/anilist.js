const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const Bottleneck = require("bottleneck");
const LRU = require("lru-cache");
const { getExternalId } = require("./id-mapping");
const dotenv = require("dotenv");
dotenv.config();

const limiter = new Bottleneck({
  maxConcurrent: 5,
  reservoir: 30,
  reservoirRefreshAmount: 30,
  reservoirRefreshInterval: 60 * 1000,
  minTime: 200,
});

limiter.on("error", (error) => {
  console.error("Bottleneck error:", error);
});

let rateLimitPromise = null;
limiter.on("failed", async (error, jobInfo) => {
  if (error.response && error.response.status === 429) {
    const retryAfter = Number(
      error.response.headers.get("retry-after") || "60"
    );
    console.warn(`Rate limit hit (429). Retrying after ${retryAfter} seconds.`);
    if (!rateLimitPromise) {
      rateLimitPromise = new Promise((resolve) =>
        setTimeout(resolve, retryAfter * 1000)
      );
    }
    await rateLimitPromise;
    rateLimitPromise = null;
    return jobInfo.retryCount < 3 ? retryAfter * 1000 : null;
  }

  console.error(
    "GraphQL request failed:",
    error.message || error,
    "Job Info:",
    jobInfo
  );

  return null;
});

const cache = new LRU({
  max: 500,
  ttl: 10 * 60 * 1000, // 10 minutes TTL for general API data
});

const logoCache = new LRU({
  max: 500,
  ttl: 60 * 60 * 1000, // 1 hour TTL for logos
});

function getCacheKey(query, variables) {
  const sortedVars = variables
    ? JSON.stringify(variables, Object.keys(variables).sort())
    : "";
  return JSON.stringify({ query, variables: sortedVars });
}

// Wrapper to cache promises, preventing dogpiling
async function getCachedResult(query, variables, token, fetchFn) {
  const key = getCacheKey(query, variables);
  if (cache.has(key)) {
    // console.log(`[Cache Hit] GraphQL: ${key}`);
    return cache.get(key); // Return the promise (resolved or pending)
  }
  // console.log(`[Cache Miss] GraphQL: ${key}`);
  const promise = fetchFn()
    .then((data) => {
      // Cache the resolved data (or the resolved promise implicitly)
      cache.set(key, Promise.resolve(data));
      return data;
    })
    .catch((err) => {
      // Don't cache errors, remove potentially pending promise from cache
      cache.delete(key);
      console.error(`Error in cached fetch for ${key}:`, err.message);
      throw err;
    });
  // Store the promise in the cache immediately
  cache.set(key, promise);
  return promise;
}

async function makeGraphQLRequest(query, variables, token) {
  // Schedule the request using the bottleneck limiter
  return limiter.schedule(async () => {
    const endpoint = "https://graphql.anilist.co";
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const options = {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      timeout: 15000, // 15 second timeout for requests
    };

    // console.log("Making GraphQL Request:", JSON.stringify({ query, variables: variables }, null, 2));

    // Check if we are currently waiting due to a rate limit response
    if (rateLimitPromise) {
      console.log("Waiting due to previous rate limit...");
      await rateLimitPromise;
    }

    const response = await fetch(endpoint, options);

    // Check for non-OK status codes
    if (!response.ok) {
      const errorBody = await response.text();
      const error = new Error(
        `GraphQL request failed: ${response.status} ${response.statusText} - ${errorBody}`
      );
      error.response = response;
      throw error;
    }

    const data = await response.json();

    // Check for errors within the GraphQL response body
    if (data.errors) {
      console.error("GraphQL Errors:", data.errors);
      const combinedErrorMsg = data.errors.map((e) => e.message).join("; ");
      throw new Error(`GraphQL API returned errors: ${combinedErrorMsg}`);
    }

    // console.log("GraphQL Response:", JSON.stringify(data.data, null, 2));
    return data;
  });
}

function logoUrl(hd, normal) {
  const merged = [].concat(hd || []).concat(normal || []); // Ensure inputs are arrays
  if (merged.length === 0) return null;

  // Prioritize English ('en') or unspecified ('und', null, undefined) logos
  const preferredLogo = merged.find(
    (e) => !e?.lang || ["en", "und"].includes(e.lang)
  );

  const logo = preferredLogo || merged[0]; // Fallback to the first logo if no preferred found
  return logo?.url ? logo.url.replace(/^http:/, "https:") : null; // Return HTTPS URL or null
}

async function getLogo(anilistId, format) {
  const cacheKey = `logo_${anilistId}_${format}`;
  if (logoCache.has(cacheKey)) {
    return logoCache.get(cacheKey);
  }

  const type = format === "MOVIE" ? "movies" : "tv";
  const idSource = format === "MOVIE" ? "themoviedb" : "thetvdb"; // Map format to correct ID source
  let externalApiId = null;

  try {
    externalApiId = await getExternalId(anilistId, idSource);
    if (!externalApiId) {
      // console.log(`No ${idSource} ID found for Anilist ID ${anilistId}, cannot fetch logo.`);
      logoCache.set(cacheKey, null);
      return null;
    }
  } catch (mapError) {
    console.error(
      `Error getting external ID for logo lookup (Anilist ID ${anilistId}):`,
      mapError
    );
    logoCache.set(cacheKey, null);
    return null;
  }

  const fanartApiKey = process.env.FANART_API_KEY;
  if (!fanartApiKey) {
    console.warn(
      "FANART_API_KEY not set in environment variables. Cannot fetch logos."
    );
    logoCache.set(cacheKey, null);
    return null;
  }

  let url = null;
  try {
    // console.log(`Fetching Fanart logo for ${type}/${externalApiId}`);
    const res = await fetch(
      `https://webservice.fanart.tv/v3/${type}/${externalApiId}?api_key=${fanartApiKey}`,
      { headers: { Accept: "application/json" }, timeout: 5000 } // Request JSON, add timeout
    );

    if (!res.ok) {
      // Fanart returns 404 if not found, handle gracefully
      if (res.status === 404) {
        console.log(`Fanart: No art found for ${type}/${externalApiId}`);
      } else {
        console.error(
          `Fanart.tv API error for ${type}/${externalApiId}: ${res.status} ${res.statusText}`
        );
      }
      logoCache.set(cacheKey, null);
      return null;
    }

    const fanartData = await res.json();

    if (type === "tv") {
      url = logoUrl(fanartData.hdtvlogo, fanartData.tvlogo);
    } else {
      url = logoUrl(fanartData.hdmovielogo, fanartData.movielogo);
    }
    // console.log(`Fanart logo URL for ${type}/${externalApiId}: ${url}`);
  } catch (fetchError) {
    console.error(
      `Error fetching Fanart.tv data for ${type}/${externalApiId}:`,
      fetchError
    );
    url = null; // Ensure url is null on error
  }

  logoCache.set(cacheKey, url);
  return url;
}

function getReleaseInfo(media) {
  if (!media || !media.startDate) return "Unknown Year"; // Handle cases with no data

  const startYear = media.startDate.year;
  const endYear = media.endDate ? media.endDate.year : null;

  if (media.format === "MOVIE") {
    return startYear ? String(startYear) : "Unknown Year";
  } else if (media.status === "RELEASING") {
    return startYear ? `${startYear} - Airing` : "Airing";
  } else if (media.status === "FINISHED") {
    if (!startYear) return "Finished";
    if (!endYear || startYear === endYear) return String(startYear);
    return `${startYear} - ${endYear}`;
  } else if (media.status === "NOT_YET_RELEASED") {
    return startYear ? `Coming ${startYear}` : "Not Yet Released";
  } else if (media.status === "CANCELLED") {
    return startYear ? `Cancelled (${startYear})` : "Cancelled";
  } else if (media.status === "HIATUS") {
    let hiatusInfo = "On Hiatus";
    if (startYear) {
      hiatusInfo += ` (${startYear}`;
      if (endYear && endYear !== startYear) hiatusInfo += `-${endYear}`;
      hiatusInfo += ")";
    }
    return hiatusInfo;
  }
  // Fallback for any other statuses or missing year
  return startYear ? String(startYear) : "Unknown Status";
}

function getReleasedDate(media) {
  if (!media || !media.startDate || !media.startDate.year) {
    return null; // No reliable start date info
  }
  try {
    const year = media.startDate.year;
    const month = media.startDate.month
      ? String(media.startDate.month).padStart(2, "0")
      : null;
    const day = media.startDate.day
      ? String(media.startDate.day).padStart(2, "0")
      : null;

    if (month && day) {
      // Prefer ISO 8601 format (YYYY-MM-DD)
      const date = new Date(year, month - 1, day); // Month is 0-indexed
      // Basic validation to check if the parsed date is valid
      if (isNaN(date.getTime())) return `${year}-${month}`; // Fallback if day is invalid
      return date.toISOString().split("T")[0];
    } else if (month) {
      return `${year}-${month}`; // YYYY-MM format
    } else {
      return String(year); // YYYY format
    }
  } catch (e) {
    console.error("Error formatting released date:", e);
    return String(media.startDate.year); // Fallback to just year on error
  }
}

async function getViewer(token) {
  const query = "query { Viewer { id } }";
  const data = await getCachedResult(query, {}, token, () =>
    makeGraphQLRequest(query, {}, token)
  );
  // console.log("Viewer data:", data);
  return data?.data?.Viewer;
}

// Reusable function to map Anilist media object to Stremio meta object
async function mapMediaToMeta(media) {
  if (!media || !media.id) return null;
  return {
    id: `anilist:${media.id}`,
    type: media.format === "MOVIE" ? "movie" : "series",
    name:
      media.title?.userPreferred || media.title?.romaji || `Anime ${media.id}`,
    genres: media.genres || [],
    poster:
      media.coverImage?.extraLarge ||
      media.coverImage?.large ||
      media.coverImage?.medium,
    background: media.bannerImage,
    description: media.description,
    logo: await getLogo(media.id, media.format),
    releaseInfo: getReleaseInfo(media),
    imdbRating: media.averageScore
      ? (media.averageScore / 10).toFixed(1)
      : null,
    released: getReleasedDate(media),
    runtime: media.duration ? `${media.duration} min` : null,
    country: media.countryOfOrigin,
    website: media.siteUrl,
  };
}

// Define the GraphQL fragment for common media fields
const mediaFieldsFragment = `
  fragment MediaFields on Media {
    id
    format
    status
    title {
      userPreferred
      romaji
    }
    genres
    coverImage {
      extraLarge
      large
      medium
    }
    bannerImage
    description(asHtml: false)
    startDate { year month day }
    endDate { year month day }
    averageScore
    duration
    relations {
      edges {
        relationType(version: 2)
        node {
          id
          type
        }
      }
    }
  }
`;

async function getCatalog(catalogType, token) {
  const user = await getViewer(token);
  if (!user) {
    console.error("Could not fetch Anilist user ID. Ensure token is valid.");
    return [];
  }
  const userId = user.id;

  let variables = { userId };
  let query = "";
  let requiresMediaList = false;

  // Map addon catalog IDs to Anilist statuses/logic
  switch (catalogType) {
    case "CURRENT":
      variables.status = ["CURRENT", "REPEATING"];
      variables.sort = ["UPDATED_TIME_DESC"];
      requiresMediaList = true;
      break;
    case "WATCHING":
      variables.status = ["CURRENT"];
      variables.sort = "UPDATED_TIME_DESC";
      requiresMediaList = true;
      break;
    case "PLANNING":
      variables.status = ["PLANNING"];
      variables.sort = ["POPULARITY_DESC"];
      requiresMediaList = true;
      break;
    case "PAUSED":
      variables.status = ["PAUSED"];
      variables.sort = ["UPDATED_TIME_DESC"];
      requiresMediaList = true;
      break;
    case "DROPPED":
      variables.status = ["DROPPED"];
      variables.sort = "UPDATED_TIME_DESC";
      requiresMediaList = true;
      break;
    case "COMPLETED":
      variables.status = ["COMPLETED"];
      variables.sort = ["UPDATED_TIME_DESC"];
      requiresMediaList = true;
      break;
    case "REPEATING":
      variables.status = ["REPEATING"];
      variables.sort = ["UPDATED_TIME_DESC"];
      requiresMediaList = true;
      break;
    // --- Add cases for POPULAR, TRENDING, GENRES etc. here if needed ---
    // Example for TRENDING
    // case 'TRENDING':
    //   variables = { sort: ['TRENDING_DESC'], type: 'ANIME', format_not: 'MUSIC' };
    //   query = `
    //       query ($page: Int, $perPage: Int, $sort: [MediaSort], $type: MediaType, $format_not: MediaFormat) {
    //         Page(page: $page, perPage: $perPage) {
    //           media(sort: $sort, type: $type, format_not: $format_not) {
    //             ...MediaFields
    //           }
    //         }
    //       }
    //       ${mediaFieldsFragment}
    //     `;
    //   break;
    default:
      console.warn(`Unsupported catalog type requested: ${catalogType}`);
      return [];
  }

  let entries = [];

  try {
    if (requiresMediaList) {
      // Query user's media list collection
      query = `
          query ($userId: Int, $status: [MediaListStatus], $sort: [MediaListSort]) {
            MediaListCollection(userId: $userId, type: ANIME, status_in: $status, sort: $sort, forceSingleCompletedList: true, chunk: 1, perChunk: 500) {
              lists {
                status
                entries {
                  # score(format: POINT_10_DECIMAL) # User score if needed
                  # progress # User progress if needed
                  media {
                    ...MediaFields
                  }
                }
              }
            }
          }
          ${mediaFieldsFragment}
        `;
      // Remove status from variables as it's used in status_in in the query
      const statusFilter = variables.status;
      delete variables.status;

      const data = await getCachedResult(query, variables, token, () =>
        makeGraphQLRequest(query, variables, token)
      );

      if (data?.data?.MediaListCollection?.lists) {
        entries = data.data.MediaListCollection.lists
          .filter((list) => statusFilter.includes(list.status))
          .flatMap((list) => list.entries.map((entry) => entry.media));
      } else {
        console.warn(
          `No lists found for user ${userId} with status ${statusFilter}`
        );
      }
    } else if (query) {
      // Handle non-list based queries (like TRENDING, POPULAR) if implemented
      variables.page = 1;
      variables.perPage = 50;
      const data = await getCachedResult(query, variables, token, () =>
        makeGraphQLRequest(query, variables, token)
      );
      entries = data?.data?.Page?.media || [];
    }
  } catch (error) {
    console.error(`Error fetching catalog data for ${catalogType}:`, error);
    return [];
  }

  // Map the fetched media entries to Stremio meta objects
  const metas = await Promise.all(
    (entries || [])
      .filter((media) => !!media)
      .map((media) => mapMediaToMeta(media))
  );

  // Filter out any null results from mapping (e.g., if mapMediaToMeta failed)
  return metas.filter((meta) => meta !== null);
}

async function getAnilistEntryByName(name, token) {
  const variables = { search: name, type: "ANIME", perPage: 1 };
  const query = `
      query ($search: String, $type: MediaType, $perPage: Int) {
        Page(page: 1, perPage: $perPage) {
          media(search: $search, type: $type) {
            id
            # Include episodes if needed for completion check here
            episodes
          }
        }
      }
    `;
  try {
    const data = await getCachedResult(query, variables, token, () =>
      makeGraphQLRequest(query, variables, token)
    );
    const media = data?.data?.Page?.media?.[0];
    if (media) {
      console.log(`Found Anilist entry by name "${name}": ID ${media.id}`);
      return media; // Return the media object { id, episodes }
    } else {
      console.log(`Could not find Anilist entry by name "${name}"`);
      return null;
    }
  } catch (error) {
    console.error(`Error searching Anilist by name "${name}":`, error);
    return null;
  }
}

// Fetch current list status/progress for a specific media ID
async function getAnilistMediaListEntry(mediaId, token) {
  const variables = { mediaId: mediaId, type: "ANIME" };
  const query = `
      query ($mediaId: Int, $type: MediaType) {
        Media(id: $mediaId, type: $type) {
          id
          episodes # Total episodes
          format
          mediaListEntry {
            id # List entry ID
            status
            progress
          }
        }
      }
    `;
  try {
    // Don't cache this since progress/status changes often
    const data = await makeGraphQLRequest(query, variables, token);
    const media = data?.data?.Media;
    if (media) {
      // console.log(`Fetched MediaListEntry for ID ${mediaId}:`, media.mediaListEntry);
      return {
        currentProgress: media.mediaListEntry?.progress ?? 0,
        currentStatus: media.mediaListEntry?.status,
        totalEpisodes: media.episodes,
        isMovie: media.format === "MOVIE",
      };
    } else {
      console.log(`Could not fetch MediaListEntry details for ID ${mediaId}`);
      return null;
    }
  } catch (error) {
    console.error(`Error fetching MediaListEntry for ID ${mediaId}:`, error);
    // If error indicates media not found vs auth error, could return specific info
    if (error.message && error.message.includes("Not Found")) {
      console.log(`Media ID ${mediaId} not found on Anilist.`);
      return { notFound: true };
    }
    return null;
  }
}

async function updateAnilistProgress(
  mediaId,
  targetEpisode,
  currentEntryData,
  token
) {
  if (!currentEntryData || currentEntryData.notFound) {
    console.log(
      `Cannot update progress for ID ${mediaId}: Media not found or details unavailable.`
    );
    return;
  }

  const { currentProgress, currentStatus, totalEpisodes, isMovie } =
    currentEntryData;

  const newProgress = isMovie ? 1 : targetEpisode;

  if (currentProgress >= newProgress) {
    console.log(
      `Skipping update for ID ${mediaId}: Progress ${currentProgress} >= target ${newProgress}`
    );
    return;
  }

  if (!isMovie && totalEpisodes != null && newProgress > totalEpisodes) {
    console.log(
      `Skipping update for ID ${mediaId}: Target episode ${newProgress} > total episodes ${totalEpisodes}`
    );
    return;
  }

  if (isMovie || (totalEpisodes != null && newProgress >= totalEpisodes)) {
    newStatus = "COMPLETED";
  } else if (currentStatus) {
    if (currentStatus !== "CURRENT") {
      newStatus = currentStatus;
    }
  }
  if (currentStatus === "COMPLETED" && newStatus !== "COMPLETED") {
    console.warn(
      `Updating progress (${newProgress}) for already COMPLETED item (ID ${mediaId}). Setting status to CURRENT.`
    );
    newStatus = "CURRENT";
  }

  const variables = {
    mediaId: mediaId,
    progress: newProgress,
    status: newStatus,
  };

  cache.clear();

  const mutation = `
      mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus) {
        SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) {
          id
          status
          progress
        }
      }
    `;

  try {
    console.log(
      `Saving Anilist progress: ID=${mediaId}, Progress=${newProgress}, Status=${newStatus}`
    );
    const data = await makeGraphQLRequest(mutation, variables, token);
    console.log(
      `Anilist progress saved successfully for ID ${mediaId}:`,
      data?.data?.SaveMediaListEntry
    );
  } catch (error) {
    console.error(`Failed to save Anilist progress for ID ${mediaId}:`, error);
    throw error;
  }
}

async function handleWatchedEpisode(
  animeName,
  anilistId,
  currentEpisode,
  preAddedOnly,
  token
) {
  let targetAnilistId = anilistId;
  let entryData = null;

  if (!targetAnilistId && animeName) {
    console.log(`No Anilist ID provided, searching by name: "${animeName}"`);
    const searchResult = await getAnilistEntryByName(animeName, token);
    if (searchResult) {
      targetAnilistId = searchResult.id;
    } else {
      console.log(
        `Could not find anime by name "${animeName}". Skipping update.`
      );
    }
  } else if (!targetAnilistId) {
    console.log("No Anilist ID or fallback name provided. Skipping update.");
  }

  entryData = await getAnilistMediaListEntry(targetAnilistId, token);

  if (!entryData) {
    console.log(
      `Could not retrieve current list status for Anilist ID ${targetAnilistId}. Skipping update.`
    );
  }

  const isOnList = entryData && entryData.currentStatus != null; // Check if it has a status on *any* list
  if (preAddedOnly && !isOnList) {
    console.log(
      `Skipping update for Anilist ID ${targetAnilistId}: 'preAddedOnly' is true and the item is not on any Anilist list.`
    );
    return;
  }

  await updateAnilistProgress(
    targetAnilistId,
    currentEpisode,
    entryData,
    token
  );
}

module.exports = {
  getCatalog,
  handleWatchedEpisode,
  // getAnilistEntryByName,
  // updateAnilistProgress,
};
