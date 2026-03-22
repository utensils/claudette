mod adjectives;
mod plants;

use rand::Rng;
use std::collections::HashMap;

pub use adjectives::ADJECTIVES;
pub use plants::PLANTS;

/// What happens when an easter egg combo is generated.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum EasterEgg {
    /// Print a message alongside the name
    Message(String),
    /// Replace the separator with something fun
    #[allow(dead_code)]
    CustomSeparator(String),
    /// Full custom display override
    Custom(String),
}

pub struct NameGenerator {
    /// Easter eggs keyed by (adjective, plant). Use "*" as a wildcard
    /// to match any adjective or any plant.
    eggs: HashMap<(String, String), EasterEgg>,
}

/// The result of generating a name.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct GeneratedName {
    pub adjective: String,
    pub plant: String,
    pub display: String,
    pub easter_egg: Option<EasterEgg>,
}

impl NameGenerator {
    pub fn new() -> Self {
        let mut this = Self {
            eggs: HashMap::new(),
        };
        this.register_default_eggs();
        this
    }

    /// Register an easter egg for an exact (adjective, plant) pair.
    pub fn add_egg(&mut self, adjective: &str, plant: &str, egg: EasterEgg) {
        self.eggs
            .insert((adjective.to_string(), plant.to_string()), egg);
    }

    /// Register an easter egg that triggers on any combo containing this word.
    /// Use "*" for the wildcard side.
    /// e.g., `add_wildcard_egg("*", "hemlock", egg)` triggers for any adjective + hemlock.
    pub fn add_wildcard_egg(&mut self, adjective: &str, plant: &str, egg: EasterEgg) {
        self.eggs
            .insert((adjective.to_string(), plant.to_string()), egg);
    }

    /// Generate a random name.
    pub fn generate(&self) -> GeneratedName {
        let mut rng = rand::thread_rng();
        let adj = ADJECTIVES[rng.gen_range(0..ADJECTIVES.len())];
        let plant = PLANTS[rng.gen_range(0..PLANTS.len())];
        self.build_name(adj, plant)
    }

    /// Generate a deterministic name from a seed (e.g. hash of a session ID).
    #[allow(dead_code)]
    pub fn generate_from_seed(&self, seed: u64) -> GeneratedName {
        let adj_idx = (seed as usize) % ADJECTIVES.len();
        let plant_idx = ((seed >> 32) as usize) % PLANTS.len();
        let adj = ADJECTIVES[adj_idx];
        let plant = PLANTS[plant_idx];
        self.build_name(adj, plant)
    }

    /// Total number of possible unique combinations.
    #[allow(dead_code)]
    pub fn namespace_size(&self) -> usize {
        ADJECTIVES.len() * PLANTS.len()
    }

    fn build_name(&self, adjective: &str, plant: &str) -> GeneratedName {
        let egg = self.find_egg(adjective, plant);

        let display = match &egg {
            Some(EasterEgg::CustomSeparator(sep)) => format!("{adjective}{sep}{plant}"),
            Some(EasterEgg::Custom(s)) => s.clone(),
            _ => format!("{adjective}-{plant}"),
        };

        GeneratedName {
            adjective: adjective.to_string(),
            plant: plant.to_string(),
            display,
            easter_egg: egg,
        }
    }

    fn find_egg(&self, adjective: &str, plant: &str) -> Option<EasterEgg> {
        // Exact match first
        if let Some(egg) = self.eggs.get(&(adjective.to_string(), plant.to_string())) {
            return Some(egg.clone());
        }
        // Wildcard on adjective
        if let Some(egg) = self.eggs.get(&("*".to_string(), plant.to_string())) {
            return Some(egg.clone());
        }
        // Wildcard on plant
        if let Some(egg) = self.eggs.get(&(adjective.to_string(), "*".to_string())) {
            return Some(egg.clone());
        }
        None
    }

    fn register_default_eggs(&mut self) {
        // Any combo with hemlock
        self.add_wildcard_egg(
            "*",
            "hemlock",
            EasterEgg::Message("\u{2620}\u{fe0f}  Careful with that one...".to_string()),
        );

        // Lazy woad
        self.add_egg(
            "lazy",
            "woad",
            EasterEgg::Message("\u{1f634} *yawns in botanical*".to_string()),
        );

        // Sleepy moss
        self.add_egg(
            "sleepy",
            "moss",
            EasterEgg::Message("\u{1f6cc} zzzZZZzzz".to_string()),
        );

        // Mighty oak
        self.add_egg(
            "mighty",
            "oak",
            EasterEgg::Message("\u{1f333} A classic for a reason.".to_string()),
        );

        // Ghostly orchid
        self.add_egg(
            "ghostly",
            "orchid",
            EasterEgg::Message(
                "\u{1f47b} The ghost orchid is real, and it's spectacular.".to_string(),
            ),
        );

        // Cosmic sage
        self.add_egg(
            "cosmic",
            "sage",
            EasterEgg::Message("\u{1f52e} The universe has advice for you.".to_string()),
        );

        // Forgotten lotus
        self.add_egg(
            "forgotten",
            "lotus",
            EasterEgg::Message("\u{1f9d8} Let go. Let grow.".to_string()),
        );

        // Wild fern
        self.add_egg(
            "wild",
            "fern",
            EasterEgg::Custom("\u{1f33f} w\u{00b7}i\u{00b7}l\u{00b7}d\u{00b7}f\u{00b7}e\u{00b7}r\u{00b7}n \u{1f33f}".to_string()),
        );

        // Smug rose
        self.add_egg(
            "smug",
            "rose",
            EasterEgg::Message("\u{1f485} Knows it's beautiful.".to_string()),
        );

        // Tiny sunflower
        self.add_egg(
            "tiny",
            "sunflower",
            EasterEgg::Message("\u{1f33b} Still reaches for the sun.".to_string()),
        );

        // Electric mint
        self.add_egg(
            "electric",
            "mint",
            EasterEgg::Message("\u{26a1} Tingly.".to_string()),
        );
    }
}

impl Default for NameGenerator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_a_name() {
        let namer = NameGenerator::new();
        let name = namer.generate();
        assert!(!name.display.is_empty());
        assert!(name.display.contains('-') || name.easter_egg.is_some());
    }

    #[test]
    fn deterministic_from_seed() {
        let namer = NameGenerator::new();
        let a = namer.generate_from_seed(42);
        let b = namer.generate_from_seed(42);
        assert_eq!(a.display, b.display);
    }

    #[test]
    fn different_seeds_differ() {
        let namer = NameGenerator::new();
        let a = namer.generate_from_seed(1);
        let b = namer.generate_from_seed(99999);
        assert_ne!(a.display, b.display);
    }

    #[test]
    fn namespace_is_large_enough() {
        let namer = NameGenerator::new();
        assert!(
            namer.namespace_size() >= 10_000,
            "Namespace too small: {}",
            namer.namespace_size()
        );
    }

    #[test]
    fn easter_egg_exact_match() {
        let namer = NameGenerator::new();
        let name = namer.build_name("mighty", "oak");
        assert!(name.easter_egg.is_some());
    }

    #[test]
    fn easter_egg_wildcard() {
        let namer = NameGenerator::new();
        let name = namer.build_name("bright", "hemlock");
        assert!(name.easter_egg.is_some());
    }

    #[test]
    fn no_easter_egg_for_normal_combo() {
        let namer = NameGenerator::new();
        let name = namer.build_name("calm", "daisy");
        assert!(name.easter_egg.is_none());
    }
}
