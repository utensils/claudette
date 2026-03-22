/// Botanical names for the name generator.
/// Curated for memorability, pronounceability, and positive associations.
pub const PLANTS: &[&str] = &[
    // Flowers
    "aster",
    "azalea",
    "begonia",
    "bluebell",
    "camellia",
    "carnation",
    "chrysanthemum",
    "clover",
    "columbine",
    "cornflower",
    "cosmos",
    "crocus",
    "daffodil",
    "dahlia",
    "daisy",
    "dandelion",
    "delphinium",
    "foxglove",
    "freesia",
    "gardenia",
    "geranium",
    "gladiolus",
    "hawthorn",
    "heather",
    "hibiscus",
    "hollyhock",
    "honeysuckle",
    "hyacinth",
    "hydrangea",
    "iris",
    "jasmine",
    "jonquil",
    "larkspur",
    "lavender",
    "lilac",
    "lily",
    "lotus",
    "lupin",
    "magnolia",
    "marigold",
    "morning-glory",
    "myrtle",
    "narcissus",
    "orchid",
    "pansy",
    "peony",
    "periwinkle",
    "petunia",
    "poppy",
    "primrose",
    "protea",
    "ranunculus",
    "rhododendron",
    "rose",
    "snapdragon",
    "sunflower",
    "sweetpea",
    "thistle",
    "tulip",
    "verbena",
    "violet",
    "wisteria",
    "zinnia",
    // Herbs & aromatics
    "basil",
    "chamomile",
    "cilantro",
    "dill",
    "fennel",
    "ginger",
    "lemongrass",
    "marjoram",
    "mint",
    "oregano",
    "parsley",
    "rosemary",
    "saffron",
    "sage",
    "tarragon",
    "thyme",
    // Trees & shrubs
    "acacia",
    "birch",
    "cedar",
    "cypress",
    "elder",
    "elm",
    "hazel",
    "hemlock",
    "holly",
    "juniper",
    "maple",
    "oak",
    "olive",
    "pine",
    "rowan",
    "spruce",
    "willow",
    "yew",
    // Ferns, mosses & other
    "bamboo",
    "bracken",
    "fern",
    "ivy",
    "lichen",
    "moss",
    "reed",
    "sorrel",
    "tansy",
    "woad",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn no_duplicate_plants() {
        let mut seen = HashSet::new();
        for plant in PLANTS {
            assert!(seen.insert(plant), "Duplicate plant: {plant}");
        }
    }

    #[test]
    fn plant_count() {
        assert!(
            PLANTS.len() >= 100,
            "Expected at least 100 plants, got {}",
            PLANTS.len()
        );
    }
}
