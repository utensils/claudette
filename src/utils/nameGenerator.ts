const ADJECTIVES = [
  "bright", "burnished", "crisp", "dappled", "dusty", "frosted", "fuzzy",
  "gilded", "glossy", "gnarled", "hazy", "lush", "mossy", "polished",
  "prickly", "rough", "rusty", "silky", "smooth", "speckled", "tangled",
  "thorny", "velvety", "weathered", "woven", "bold", "brash", "calm",
  "cheerful", "clever", "cozy", "daring", "defiant", "eager", "fierce",
  "gentle", "giddy", "grumpy", "hardy", "hasty", "jolly", "keen", "lazy",
  "lively", "mellow", "merry", "mighty", "noble", "patient", "plucky",
  "proud", "quiet", "rowdy", "serene", "shy", "sleepy", "smug", "snappy",
  "solemn", "steady", "stoic", "stubborn", "swift", "tender", "timid",
  "vivid", "wandering", "wary", "wild", "wistful", "witty", "zealous",
  "ancient", "bitter", "brisk", "dim", "faint", "fleeting", "grand",
  "hushed", "little", "luminous", "massive", "radiant", "roaring", "secret",
  "shadowy", "silent", "slender", "stark", "subtle", "tiny", "towering",
  "vast", "ashen", "azure", "copper", "crimson", "emerald", "golden",
  "ivory", "midnight", "scarlet", "silver", "cosmic", "crooked", "feral",
  "forgotten", "ghostly", "hollow", "lost", "muddy", "phantom", "restless",
  "rickety", "soggy", "tattered", "twisted", "unlikely", "unruly", "wobbly",
];

const PLANTS = [
  "aster", "azalea", "bluebell", "camellia", "clover", "columbine",
  "cornflower", "cosmos", "crocus", "daffodil", "dahlia", "daisy",
  "dandelion", "foxglove", "freesia", "gardenia", "geranium", "hawthorn",
  "heather", "hibiscus", "hollyhock", "honeysuckle", "hyacinth", "iris",
  "jasmine", "larkspur", "lavender", "lilac", "lily", "lotus", "lupin",
  "magnolia", "marigold", "myrtle", "orchid", "pansy", "peony",
  "periwinkle", "poppy", "primrose", "protea", "rose", "snapdragon",
  "sunflower", "sweetpea", "thistle", "tulip", "verbena", "violet",
  "wisteria", "zinnia", "basil", "chamomile", "dill", "fennel", "ginger",
  "mint", "oregano", "rosemary", "saffron", "sage", "thyme", "acacia",
  "birch", "cedar", "cypress", "elder", "elm", "hazel", "hemlock", "holly",
  "juniper", "maple", "oak", "olive", "pine", "rowan", "spruce", "willow",
  "yew", "bamboo", "bracken", "fern", "ivy", "lichen", "moss", "reed",
  "sorrel", "tansy", "woad",
];

const ACTIONS = [
  "blooming", "climbing", "coasting", "dancing", "dashing", "drifting",
  "floating", "flowing", "flying", "gliding", "growing", "hopping",
  "humming", "leaping", "nesting", "racing", "resting", "rising",
  "roaming", "rolling", "running", "sailing", "singing", "skating",
  "soaring", "spinning", "sprinting", "strolling", "surfing", "swaying",
  "swimming", "swinging", "trailing", "tumbling", "turning", "twirling",
  "wading", "walking", "weaving", "whirling",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateWorkspaceName(): string {
  return `${pick(ADJECTIVES)}-${pick(PLANTS)}-${pick(ACTIONS)}`;
}
