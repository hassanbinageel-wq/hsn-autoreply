/** Text for search: lower case, without Arabic diacritics / tatweel, unified alef / yaa / taa marbuta, no leading @. */
export const normText = (v: string) => v.toLowerCase().replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/^@/, "").trim();
