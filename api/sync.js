// Version "Master Sync - V49 SPEED OPTIMIZER"
// V48 + Compression d'images à la volée via SHARP (WebP + Resize)

const Airtable = require("airtable");
const axios = require("axios");
const sharp = require("sharp"); // Ajout de la librairie de traitement d'image

// --- CONFIGURATION ---
const airtableBase = new Airtable({
  apiKey: process.env.AIRTABLE_API_KEY,
}).base(process.env.AIRTABLE_BASE_ID);

const webflowClient = axios.create({
  baseURL: "https://api.webflow.com/v2",
  headers: {
    Authorization: `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  },
});

const WF_IDS = {
  products: process.env.WF_COLLECTION_ID_PRODUITS,
  categories: process.env.WF_COLLECTION_ID_CATEGORIES,
  partners: process.env.WF_COLLECTION_ID_PARTENAIRES,
};

const AIRTABLE_TABLE_PRODUITS = "Gisement";
const AIRTABLE_TABLE_PARTENAIRES = "Partenaires";

// --- HELPER FUNCTIONS ---

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function slugify(text) {
  if (!text) return "";
  return text
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/&/g, "-et-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function cleanFields(obj) {
  Object.keys(obj).forEach((key) => {
    if (obj[key] === null || obj[key] === undefined || obj[key] === "") {
      delete obj[key];
    }
  });
  return obj;
}

function makeProxyUrl(originalUrl, req) {
  if (!originalUrl) return null;
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  return `${protocol}://${host}/api/sync?proxy_url=${encodeURIComponent(
    originalUrl
  )}`;
}

// --- GESTION DES OPTIONS (VERSION BLINDÉE V47/48) ---
let _collectionSchemaCache = null;

async function getOrAddOptionId(collectionId, fieldSlug, optionName, log) {
  if (!optionName) return null;

  try {
    const res = await webflowClient.get(`/collections/${collectionId}`);
    _collectionSchemaCache = res.data;

    if (!_collectionSchemaCache || !_collectionSchemaCache.fields) {
      if (log)
        log(`❌ CRITIQUE : Impossible de lire les champs de la collection.`);
      return null;
    }

    const field = _collectionSchemaCache.fields.find(
      (f) => f.slug === fieldSlug
    );

    if (!field) {
      if (log) log(`⚠️ ERREUR : Le champ "${fieldSlug}" n'existe pas !`);
      return null;
    }

    const currentOptions = field.options || field.validations?.options || [];

    let existingOption = currentOptions.find(
      (o) => o.name.toLowerCase() === optionName.toLowerCase()
    );
    if (existingOption) return existingOption.id;

    if (log) log(`   ✨ Option '${optionName}' inconnue. Création...`);

    const newOptions = [...currentOptions, { name: optionName }];

    await webflowClient.patch(
      `/collections/${collectionId}/fields/${field.id}`,
      {
        isRequired: field.isRequired,
        displayName: field.displayName,
        validations: { options: newOptions },
      }
    );

    await delay(2000);

    const resUpdated = await webflowClient.get(`/collections/${collectionId}`);

    if (!resUpdated.data || !resUpdated.data.fields) {
      if (log)
        log(
          `❌ ERREUR API : La re-lecture de la collection a échoué (pas de champs).`
        );
      return null;
    }

    const updatedField = resUpdated.data.fields.find(
      (f) => f.slug === fieldSlug
    );

    if (!updatedField) {
      if (log) log(`❌ ERREUR : Le champ a disparu après mise à jour.`);
      return null;
    }

    const valOptions = updatedField.validations?.options;
    const rootOptions = updatedField.options;
    const updatedOptionsList = valOptions || rootOptions || [];

    const newOptionEntry = updatedOptionsList.find(
      (o) => o.name.toLowerCase() === optionName.toLowerCase()
    );

    if (newOptionEntry) {
      if (log) log(`      -> ✅ Option créée (ID: ${newOptionEntry.id})`);
      return newOptionEntry.id;
    } else {
      if (log) log(`      -> ❌ ECHEC : Option introuvable après création.`);
      return null;
    }
  } catch (err) {
    const msg = err.response
      ? `API Error ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;
    if (log) log(`❌ Erreur Option (Catch): ${msg}`);
    return null;
  }
}

// --- FONCTIONS EXISTANTES ---

async function findOrCreateItem(collectionId, rawName) {
  if (!rawName) return null;
  const name = rawName.toString().trim();
  try {
    const response = await webflowClient.get(
      `/collections/${collectionId}/items?limit=100`
    );
    const items = response.data.items || [];
    const match = items.find(
      (i) =>
        i.fieldData &&
        i.fieldData.name &&
        i.fieldData.name.toLowerCase() === name.toLowerCase()
    );
    if (match) return match.id;

    const createResponse = await webflowClient.post(
      `/collections/${collectionId}/items`,
      {
        isArchived: false,
        isDraft: false,
        fieldData: { name: name, slug: slugify(name) },
      }
    );
    return createResponse.data.id;
  } catch (err) {
    return null;
  }
}

async function getPartnerName(recordId) {
  if (!recordId) return null;
  try {
    const record = await airtableBase(AIRTABLE_TABLE_PARTENAIRES).find(
      recordId
    );
    return record.get("Nom Société") || record.get("Nom");
  } catch (e) {
    return null;
  }
}

// --- NOUVEAU PROXY AVEC COMPRESSION SHARP (V49) ---
async function handleProxy(req, res) {
  const imageUrl = req.query.proxy_url;
  if (!imageUrl) return res.status(404).send("No URL provided");

  try {
    // 1. Récupérer l'image source en Stream
    const response = await axios({
      method: "get",
      url: decodeURIComponent(imageUrl),
      responseType: "stream",
    });

    // 2. Créer le pipeline de transformation
    const transform = sharp()
      .resize({
        width: 1600, // Largeur max (Full HD suffisant pour le web)
        withoutEnlargement: true, // Ne pas agrandir si l'image est petite
      })
      .webp({ quality: 80 }); // Conversion en WebP à 80% de qualité

    // 3. Définir le bon header pour Webflow (Webflow gère très bien le WebP maintenant)
    res.setHeader("Content-Type", "image/webp");

    // 4. Pipe : Source -> Sharp -> Réponse
    response.data.pipe(transform).pipe(res);
  } catch (error) {
    console.error("Proxy Error:", error);
    res.status(500).send("Error fetching or processing image");
  }
}

// --- MAIN SCRIPT ---

module.exports = async (req, res) => {
  if (req.query.proxy_url) return handleProxy(req, res);
  if (req.query.secret !== process.env.SYNC_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  const logs = [];
  const log = (msg) => {
    console.log(msg);
    logs.push(msg);
  };

  try {
    const records = await airtableBase(AIRTABLE_TABLE_PRODUITS)
      .select({
        filterByFormula:
          "OR({Status SYNC} = 'A Publier', {Status SYNC} = 'Mise à jour demandée')",
        maxRecords: 5,
      })
      .firstPage();

    if (records.length === 0)
      return res
        .status(200)
        .json({ message: "Rien à synchroniser.", logs: logs });

    log(`${records.length} produits à traiter.`);

    for (const record of records) {
      const productName = record.get("Nom affiché");
      const webflowId = record.get("Webflow item ID");
      const baseSlug =
        record.get("Slug") ||
        slugify(productName) + "-" + Math.floor(Math.random() * 1000);

      log(`\n🔎 TRAITEMENT : ${productName}`);

      let webflowPartnerId = null;
      const partnerLink = record.get("Partenaire");
      if (partnerLink && partnerLink.length > 0) {
        const pName = await getPartnerName(partnerLink[0]);
        webflowPartnerId = await findOrCreateItem(WF_IDS.partners, pName);
      }

      const rawCategories = record.get("Category Produit");
      let webflowCategoryIds = [];
      if (rawCategories && Array.isArray(rawCategories)) {
        for (const catName of rawCategories) {
          const cId = await findOrCreateItem(WF_IDS.categories, catName);
          if (cId) webflowCategoryIds.push(cId);
        }
      }

      const statutAirtable = record.get("Statut");
      let statutVenteId = null;

      if (statutAirtable) {
        log(`   🔹 Statut Airtable : "${statutAirtable}"`);
        statutVenteId = await getOrAddOptionId(
          WF_IDS.products,
          "statut-vente-2",
          statutAirtable,
          log
        );
      }

      const mainImageAttach = record.get("Image principale");
      const mainImageUrl =
        mainImageAttach && mainImageAttach.length > 0
          ? makeProxyUrl(mainImageAttach[0].url, req)
          : null;

      const galleryAttach = record.get("Images galerie") || [];
      const galleryUrls = galleryAttach.map((img) =>
        makeProxyUrl(img.url, req)
      );

      let fieldData = {
        name: productName,
        slug: baseSlug,
        "marque-produit": record.get("Marque produit"),
        "reference-produit": record.get("Référence produit"),
        unite: record.get("Unité"),
        "stock-de-depart": record.get("Stock de départ"),
        "stock-restant": record.get("Stock restant"),
        "info-sup-stock": record.get("Info sup Stock"),
        "dimensions-du-produit": record.get("Dimensions du produit"),
        description: record.get("Description"),
        "prix-de-vente": record.get("Prix de vente"),
        "prix-du-neuf": record.get("Prix du neuf"),
        "info-sup-prix": record.get("Info sup Prix"),
        "pourcentage-reduction": record
          .get("Pourcentage réduction")
          ?.toString(),
        "lien-vers-l-annonce": record.get("Lien vers l'annonce"),
        partenaire: webflowPartnerId,
        "category-produit":
          webflowCategoryIds.length > 0 ? webflowCategoryIds : null,
        "image-principale": mainImageUrl,
        "images-galerie": galleryUrls.length > 0 ? galleryUrls : null,
        "statut-vente-2": statutVenteId,
      };

      fieldData = cleanFields(fieldData);

      // LOG V48 : Check des champs
      const keysUpdated = Object.keys(fieldData).join(", ");
      log(`   📝 Champs inclus dans le paquet : [${keysUpdated}]`);

      let itemId = webflowId;

      try {
        if (!itemId) {
          log("   🚀 Création...");
          const createRes = await webflowClient.post(
            `/collections/${WF_IDS.products}/items`,
            {
              isArchived: false,
              isDraft: false,
              fieldData: fieldData,
            }
          );
          itemId = createRes.data.id;
          log(`   ✅ SUCCÈS (ID: ${itemId})`);
        } else {
          log("   🚀 Mise à jour...");
          try {
            await webflowClient.patch(
              `/collections/${WF_IDS.products}/items/${itemId}`,
              {
                isArchived: false,
                isDraft: false,
                fieldData: fieldData,
              }
            );
            log(`   ✅ SUCCÈS.`);
          } catch (updateErr) {
            if (
              updateErr.response &&
              updateErr.response.data &&
              updateErr.response.data.code === "resource_not_found"
            ) {
              log(
                "   ⚠️ Item introuvable (404). Auto-réparation : Recréation..."
              );
              const createRes = await webflowClient.post(
                `/collections/${WF_IDS.products}/items`,
                {
                  isArchived: false,
                  isDraft: false,
                  fieldData: fieldData,
                }
              );
              itemId = createRes.data.id;
              log(`   ✅ SUCCÈS RECRÉATION (Nouvel ID: ${itemId})`);
            } else {
              throw updateErr;
            }
          }
        }

        await airtableBase(AIRTABLE_TABLE_PRODUITS).update(record.id, {
          "Status SYNC": "Publié",
          "Webflow item ID": itemId,
          Slug: baseSlug,
        });
      } catch (err) {
        const msg = err.response
          ? JSON.stringify(err.response.data)
          : err.message;
        log(`   ❌ ECHEC: ${msg}`);
        await airtableBase(AIRTABLE_TABLE_PRODUITS).update(record.id, {
          "Status SYNC": "Erreur",
        });
      }
    }

    res.status(200).json({ success: true, logs: logs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, logs: logs });
  }
};
