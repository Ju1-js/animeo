// --- Addon Interface (addon.js content moved here for clarity, but keep it in addon.js) ---

const { addonBuilder } = require("stremio-addon-sdk");
const { getNameFromCinemetaId } = require("./lib/cinemeta");
const { getCatalog, handleWatchedEpisode } = require("./lib/anilist"); // Updated import
const { getAnilistId } = require("./lib/id-mapping");

const CATALOGS = [
  // These match the *original* request, but the logic in anilist.js is now based on the example
  // Feel free to add more catalogs here later (e.g., POPULAR, TRENDING) if needed
  {
    id: "CURRENT", // Maps to example's 'CURRENT' + 'REPEATING' combined logic initially, then refined
    type: "anime",
    name: "Currently watching",
  },
  {
    id: "REPEATING", // Example handles this within the 'CURRENT' query sort, but can be requested separately
    type: "anime",
    name: "Repeating",
  },
  {
    id: "PLANNING",
    type: "anime",
    name: "Planning to watch",
  },
  {
    id: "COMPLETED",
    type: "anime",
    name: "Completed",
  },
  {
    id: "PAUSED",
    type: "anime",
    name: "Paused",
  },
  // Add other catalogs from the example if desired, e.g.:
  // { id: 'WATCHING', type: 'anime', name: 'Watching (Strict)' },
  // { id: 'DROPPED', type: 'anime', name: 'Dropped' },
  { id: "SEQUELS", type: "anime", name: "Sequels to Completed" },
  // { id: 'STORIES', type: 'anime', name: 'Related Stories to Completed' },
  // { id: 'POPULAR', type: 'anime', name: 'Popular This Season' },
  // { id: 'TRENDING', type: 'anime', name: 'Trending Now' },
  { id: "ALLPOPULAR", type: "anime", name: "All Time Popular" },
  // { id: 'ROMANCE', type: 'anime', name: 'Trending Romance' },
  // { id: 'ACTION', type: 'anime', name: 'Trending Action' },
  // { id: 'ADVENTURE', type: 'anime', name: 'Trending Adventure' },
  // { id: 'FANTASY', type: 'anime', name: 'Trending Fantasy' },
  // { id: 'COMEDY', type: 'anime', name: 'Trending Comedy' },
];

// Docs: https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md
const builder = new addonBuilder({
  id: "com.Ju1-js.Synkuru",
  version: "0.0.2",
  name: "Synkuru",
  description:
    "Synkuru interfaces with Anilist and *will allow custom AnimeTosho RSS feeds.",
  background:
    "https://raw.githubusercontent.com/Ju1-js/synkuru/main/static/media/addon-background.png",
  logo: "https://raw.githubusercontent.com/Ju1-js/synkuru/main/static/media/addon-logo.png",
  resources: ["catalog", "meta", "subtitles"],
  types: ["anime", "movie", "series"],
  catalogs: CATALOGS,
  idPrefixes: ["anilist", "tt", "kitsu"],
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  config: [
    {
      key: "token",
      type: "text",
      title: "Anilist token",
      required: true,
    },
    {
      key: "enableSearch",
      type: "checkbox",
      title: "Enable search fallback (Cinemeta)",
      default: false,
    },
    {
      key: "preAddedOnly",
      type: "checkbox",
      title: "Only update progress for pre-added anime",
      default: false,
    },
  ],
});

builder.defineSubtitlesHandler(async (args) => {
  const { token, enableSearch, preAddedOnly } = args.config;

  if (!token) {
    console.error("Anilist token not configured.");
    // return Promise.resolve({ subtitles: [] });
    return Promise.reject(new Error("Anilist token not configured."));
  }

  let anilistId = null;
  let animeName = null;
  let episode = 0;

  console.log(
    `Handling subtitle request for ID: ${args.id}, Type: ${args.type}`
  );

  try {
    if (args.id.startsWith("kitsu:")) {
      const [_, id, currEp] = args.id.split(":");
      anilistId = await getAnilistId(id, "kitsu");
      episode = args.type === "movie" ? 1 : parseInt(currEp || "1");
      console.log(
        `Kitsu ID ${id} mapped to Anilist ID: ${anilistId}, Episode: ${episode}`
      );
    } else if (args.id.startsWith("tt")) {
      let [id, seasonName, currEp] = args.id.split(":");
      // For movies or series, try mapping IMDB ID first
      anilistId = await getAnilistId(id, "imdb");
      episode = args.type === "movie" ? 1 : parseInt(currEp || "1");
      console.log(
        `IMDB ID ${id} mapped to Anilist ID: ${anilistId}, Episode: ${episode}`
      );

      // Fallback to name search if mapping fails and search is enabled
      if (!anilistId && enableSearch && args.type === "series") {
        const season = parseInt(seasonName || "1");
        animeName = await getNameFromCinemetaId(id, args.type);
        if (animeName && season > 1) {
          animeName += ` season ${season}`;
        }
        console.log(
          `IMDB ID ${id} mapping failed, falling back to search name: "${animeName}", Episode: ${episode}`
        );
      } else if (!anilistId && args.type === "movie") {
        animeName = await getNameFromCinemetaId(id, args.type);
        console.log(`IMDB ID ${id} mapping failed for movie.`);
      }
    } else if (args.id.startsWith("anilist:")) {
      const [_, id, currEp] = args.id.split(":"); // Anilist ID might contain episode in some contexts
      anilistId = parseInt(id);
      episode = args.type === "movie" ? 1 : parseInt(currEp || "1");
      console.log(`Direct Anilist ID: ${anilistId}, Episode: ${episode}`);
    }

    // Ensure we have valid data to proceed
    if ((anilistId || animeName) && episode > 0) {
      console.log(
        `Attempting to update Anilist. ID: ${anilistId}, Name: ${animeName}, Episode: ${episode}`
      );
      await handleWatchedEpisode(
        animeName,
        anilistId,
        episode,
        preAddedOnly,
        token
      );
      console.log(`Update call finished for Episode: ${episode}`);
    } else {
      console.log(
        "Could not determine Anilist ID or Anime Name, or episode is invalid. Skipping update."
      );
    }
  } catch (err) {
    console.error("Error during subtitle handler:", err.message || err);
    if (err.response && err.response.data) {
      console.error("Response data:", err.response.data);
    }
  }

  // Always return empty subtitles as this is just a trigger
  return Promise.resolve({ subtitles: [] });
});

builder.defineCatalogHandler(async (args) => {
  const { token } = args.config;
  let metas = [];

  if (!token) {
    console.error("Anilist token not configured for catalog request.");
    // return Promise.resolve({ metas: [] });
    return Promise.reject(new Error("Anilist token not configured."));
  }

  const catalogId = args.id;
  console.log(`Fetching catalog: ${catalogId}`);

  try {
    metas = await getCatalog(catalogId, token);
    console.log(`Fetched ${metas.length} items for catalog: ${catalogId}`);
  } catch (err) {
    console.error(`Error fetching catalog ${catalogId}:`, err.message || err);
    if (err.response && err.response.data) {
      console.error("Response data:", err.response.data);
    }
    // Return empty on error to avoid breaking Stremio UI
    metas = [];
  }

  return { metas };
});

module.exports = builder.getInterface();
