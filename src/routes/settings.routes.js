const express = require("express");
const { PackagePricing, Setting } = require("../models");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

function normalizeLegacyFeatures(features) {
  if (Array.isArray(features)) return features;
  if (typeof features === "string") return features.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeLegacyPackage(item, index) {
  return {
    ...item,
    description: item.description || item.bestFor || "",
    displayOrder: Number(item.displayOrder ?? index),
    status: item.status || "active",
    buttonText: item.buttonText || "Package details",
    buttonLink: item.buttonLink || `/pricing/${item.slug}`,
    features: normalizeLegacyFeatures(item.features),
  };
}

router.get("/packages", asyncHandler(async (_req, res) => {
  const pricing = await PackagePricing.find({ status: "active" }).sort({ displayOrder: 1, createdAt: 1 });
  if (pricing.length) {
    return res.json({
      ok: true,
      packages: pricing.map((item) => ({
        _id: item._id,
        slug: item.slug,
        name: item.name,
        description: item.description,
        bestFor: item.bestFor || item.description,
        price: item.price,
        displayOrder: item.displayOrder,
        highlightBadge: item.highlightBadge,
        buttonText: item.buttonText,
        buttonLink: item.buttonLink || `/pricing/${item.slug}`,
        recommended: item.recommended,
        features: (item.features || []).sort((a, b) => a.order - b.order).map((feature) => feature.text || feature),
      })),
    });
  }
  const setting = await Setting.findOne({ key: "packages" });
  const packages = Array.isArray(setting?.value) ? setting.value.map(normalizeLegacyPackage) : null;
  res.json({ ok: true, packages });
}));

router.get("/company", asyncHandler(async (_req, res) => {
  const setting = await Setting.findOne({ key: "companyDetails" });
  res.json({ ok: true, companyDetails: setting?.value || {} });
}));

router.get("/team-profiles", asyncHandler(async (_req, res) => {
  const setting = await Setting.findOne({ key: "teamProfiles" });
  res.json({ ok: true, teamProfiles: Array.isArray(setting?.value) ? setting.value : null });
}));

module.exports = router;
