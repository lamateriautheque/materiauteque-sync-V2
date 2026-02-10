// Version "Master Sync - V59 COMPACT PROXY"
// Force la compression des images pour passer sous la limite de 4.5MB de Vercel

const Airtable = require('airtable');
const axios = require('axios');
const sharp = require('sharp'); // Réactivé pour la compression indispensable

// --- 1. CONFIGURATION API ---
const airtableBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

const webflowClient = axios.create({
  baseURL: 'https://api.webflow.com/v2',
  headers: {
    'Authorization': `Bearer ${process.env.WEBFLOW_API_TOKEN}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
});

const WF_IDS = {
  products: process.env.WF_COLLECTION_ID_PRODUITS,
  categories: process.env.WF_COLLECTION_ID_CATEGORIES,
  partners: process.env.WF_COLLECTION_ID_PARTENAIRES
};

// --- 2. CONFIGURATION DES TABLES AIRTABLE ---
const AIRTABLE_TABLE_PRODUITS = 'Gisement V2'; 
const AIRTABLE_TABLE_PARTENAIRES = 'Partenaires V2';

// --- 3. CONFIGURATION DES SLUGS WEBFLOW (V53 Validée) ---
const SLUGS = {
    nom: 'name',
    slug: 'slug',
    statut: 'statut-vente',        
    partenaire: 'partenaire',
    categorie: 'categorie-produit', 
    marque: 'marque-produit',
    ref: 'reference-produit',
    unite: 'unite',
    stock_depart: 'stock-de-depart',
    stock_restant: 'stock-restant',
    info_stock: 'infos-sup-stock',  
    dims: 'dimensions-du-produit',
    desc: 'description',
    prix_vente: 'prix-de-vente',
    prix_neuf: 'prix-du-neuf',
    info_prix: 'info-sup-prix',
    reduction: 'pourcentage-reduction',
    lien: 'lien-vers-l-annonce',
    img_main: 'image-principale',
    img_galerie: 'images-galerie'
};

// --- HELPER FUNCTIONS ---

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function slugify(text) {
  if (!text) return '';
  return text.toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-').replace(/&/g, '-et-')
    .replace(/[^\w\-]+/g, '').replace(/\-\-+/g, '-')
    .replace(/^-+/, '').replace(/-+$/, '');
}

function cleanFields(obj) {
  Object.keys(obj).forEach(key => {
    if (obj[key] === null || obj[key] === undefined || obj[key] === "") {
      delete obj[key];
    }
  });
  return obj;
}

// --- PROXY COMPACTEUR (V59) ---
async function handleProxy(req, res) {
    const imageUrl = req.query.proxy_url;
    if (!imageUrl) return res.status(404).send('No URL provided');
    
    try {
        // 1. Télécharger l'image brute depuis Airtable
        const response = await axios({
            method: 'get',
            url: decodeURIComponent(imageUrl),
            responseType: 'arraybuffer', // On prend tout en mémoire
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });
        
        // 2. COMPRESSION AGRESSIVE
        // Objectif : Passer sous la barre des 4.5MB de Vercel
        const optimizedBuffer = await sharp(response.data)
            .resize({ width: 1200, withoutEnlargement: true }) // Max 1200px
            .jpeg({ quality: 80, mozjpeg: true }) // JPEG optimisé (plus compatible que WebP parfois)
            .toBuffer();

        // 3. Envoi à Webflow
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Length', optimizedBuffer.length);
        res.status(200).send(optimizedBuffer);
        
    } catch (error) {
        console.error("Proxy Error:", error.message);
        // Si ça plante, on renvoie une erreur explicite
        res.status(500).send('Image processing failed');
    }
}

function makeProxyUrl(originalUrl, req) {
    if (!originalUrl) return null;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    return `${protocol}://${host}/api/sync?proxy_url=${encodeURIComponent(originalUrl)}`;
}

// --- GESTION DES OPTIONS ---
let _collectionSchemaCache = null;

async function getOrAddOptionId(collectionId, fieldSlug, optionName, log) {
    if (!optionName) return null;
    try {
        const res = await webflowClient.get(`/collections/${collectionId}`);
        _collectionSchemaCache = res.data;

        if (!_collectionSchemaCache || !_collectionSchemaCache.fields) return null;

        const field = _collectionSchemaCache.fields.find(f => f.slug === fieldSlug);
        
        if (!field) {
            if (log) log(`⚠️ ERREUR : Le champ slug "${fieldSlug}" n'existe pas.`);
            return null;
        }

        const currentOptions = field.options || field.validations?.options || [];
        
        let existingOption = currentOptions.find(o => o.name.toLowerCase() === optionName.toLowerCase());
        if (existingOption) return existingOption.id;

        if (log) log(`   ✨ Création option '${optionName}'...`);
        const newOptions = [...currentOptions, { name: optionName }];
        
        await webflowClient.patch(`/collections/${collectionId}/fields/${field.id}`, {
            isRequired: field.isRequired,
            displayName: field.displayName,
            validations: { options: newOptions }
        });

        await delay(2000);

        const resUpdated = await webflowClient.get(`/collections/${collectionId}`);
        const updatedField = resUpdated.data.fields.find(f => f.slug === fieldSlug);
        const updatedOptionsList = updatedField.validations?.options || updatedField.options || [];
        const newOptionEntry = updatedOptionsList.find(o => o.name.toLowerCase() === optionName.toLowerCase());
        
        if (newOptionEntry) return newOptionEntry.id;
        return null;
    } catch (err) {
        if (log) log(`❌ Erreur Option: ${err.message}`);
        return null;
    }
}

async function findOrCreateItem(collectionId, rawName) {
  if (!rawName) return null;
  const name = rawName.toString().trim();
  try {
    const response = await webflowClient.get(`/collections/${collectionId}/items?limit=100`);
    const items = response.data.items || [];
    const match = items.find(i => i.fieldData && i.fieldData.name && i.fieldData.name.toLowerCase() === name.toLowerCase());
    if (match) return match.id;
    
    const createResponse = await webflowClient.post(`/collections/${collectionId}/items`, {
      isArchived: false, isDraft: false, fieldData: { name: name, slug: slugify(name) }
    });
    return createResponse.data.id;
  } catch (err) { return null; }
}

async function getPartnerName(recordId) {
    if (!recordId) return null;
    try {
        const record = await airtableBase(AIRTABLE_TABLE_PARTENAIRES).find(recordId);
        return record.get('Nom Société') || record.get('Nom'); 
    } catch (e) { return null; }
}

// --- MAIN SCRIPT ---

module.exports = async (req, res) => {
  if (req.query.proxy_url) return handleProxy(req, res);
  if (req.query.secret !== process.env.SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  try {
    const records = await airtableBase(AIRTABLE_TABLE_PRODUITS).select({
      filterByFormula: "OR({Status SYNC} = 'A Publier', {Status SYNC} = 'Mise à jour demandée')",
      maxRecords: 5 
    }).firstPage();

    if (records.length === 0) return res.status(200).json({ message: 'Rien à synchroniser.', logs: logs });

    log(`${records.length} produits trouvés.`);

    for (const record of records) {
      const productName = record.get('Nom affiché');
      const webflowId = record.get('Webflow item ID'); 
      const baseSlug = record.get('Slug') || slugify(productName) + '-' + Math.floor(Math.random() * 1000);
      
      log(`\n🔎 TRAITEMENT : ${productName}`);

      let webflowPartnerId = null;
      const partnerLink = record.get('Partenaire');
      if (partnerLink && partnerLink.length > 0) {
           const pName = await getPartnerName(partnerLink[0]);
           webflowPartnerId = await findOrCreateItem(WF_IDS.partners, pName);
      }

      const rawCategories = record.get('Category Produit'); 
      let webflowCategoryIds = [];
      if (rawCategories && Array.isArray(rawCategories)) {
          for (const catName of rawCategories) {
              const cId = await findOrCreateItem(WF_IDS.categories, catName);
              if (cId) webflowCategoryIds.push(cId);
          }
      }

      const statutAirtable = record.get('Statut'); 
      let statutVenteId = null;
      if (statutAirtable) {
          log(`   🔹 Statut : "${statutAirtable}"`);
          statutVenteId = await getOrAddOptionId(WF_IDS.products, SLUGS.statut, statutAirtable, log);
      }

      const mainImageAttach = record.get('Image principale');
      const mainImageUrl = (mainImageAttach && mainImageAttach.length > 0) 
          ? makeProxyUrl(mainImageAttach[0].url, req) 
          : null;
      const galleryAttach = record.get('Images galerie') || [];
      const galleryUrls = galleryAttach.map(img => makeProxyUrl(img.url, req));

      let fieldData = {};
      
      fieldData[SLUGS.nom] = productName;
      fieldData[SLUGS.slug] = baseSlug;
      fieldData[SLUGS.marque] = record.get('Marque produit');
      fieldData[SLUGS.ref] = record.get('Référence produit');
      fieldData[SLUGS.unite] = record.get('Unité');
      fieldData[SLUGS.stock_depart] = record.get('Stock de départ');
      fieldData[SLUGS.stock_restant] = record.get('Stock restant');
      fieldData[SLUGS.info_stock] = record.get('Info sup Stock');
      fieldData[SLUGS.dims] = record.get('Dimensions du produit');
      fieldData[SLUGS.desc] = record.get('Description');
      fieldData[SLUGS.prix_vente] = record.get('Prix de vente');
      fieldData[SLUGS.prix_neuf] = record.get('Prix du neuf');
      fieldData[SLUGS.info_prix] = record.get('Info sup Prix');
      fieldData[SLUGS.reduction] = record.get('Pourcentage réduction')?.toString();
      fieldData[SLUGS.lien] = record.get("Lien vers l'annonce");
      
      fieldData[SLUGS.partenaire] = webflowPartnerId;
      
      if (webflowCategoryIds.length > 0) {
          fieldData[SLUGS.categorie] = webflowCategoryIds;
      }
      
      fieldData[SLUGS.img_main] = mainImageUrl;
      if (galleryUrls.length > 0) {
          fieldData[SLUGS.img_galerie] = galleryUrls;
      }
      
      fieldData[SLUGS.statut] = statutVenteId;

      fieldData = cleanFields(fieldData);
      
      const keysUpdated = Object.keys(fieldData).join(', ');
      log(`   📝 Champs prêts : [${keysUpdated}]`);

      let itemId = webflowId;

      try {
          if (!itemId) {
              log("   🚀 Création...");
              const createRes = await webflowClient.post(`/collections/${WF_IDS.products}/items`, {
                  isArchived: false, isDraft: false, fieldData: fieldData
              });
              itemId = createRes.data.id;
              log(`   ✅ SUCCÈS (ID: ${itemId})`);
          } else {
              log("   🚀 Mise à jour...");
              try {
                  await webflowClient.patch(`/collections/${WF_IDS.products}/items/${itemId}`, {
                      isArchived: false, isDraft: false, fieldData: fieldData
                  });
                  log(`   ✅ SUCCÈS.`);
              } catch (updateErr) {
                  if (updateErr.response && updateErr.response.data && updateErr.response.data.code === 'resource_not_found') {
                      log("   ⚠️ Item introuvable (404). Auto-réparation : Recréation...");
                      const createRes = await webflowClient.post(`/collections/${WF_IDS.products}/items`, {
                          isArchived: false, isDraft: false, fieldData: fieldData
                      });
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
            "Slug": baseSlug
          });

      } catch (err) {
          const msg = err.response ? JSON.stringify(err.response.data) : err.message;
          log(`   ❌ ECHEC: ${msg}`);
          await airtableBase(AIRTABLE_TABLE_PRODUITS).update(record.id, { "Status SYNC": "Erreur" });
      }
    }

    res.status(200).json({ success: true, logs: logs });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, logs: logs });
  }
};