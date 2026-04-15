use claudette::names::*;

/// NameGenerator::new() should succeed.
#[test]
fn test_names_generator_new() {
    let ng = NameGenerator::new();
    assert!(ng.namespace_size() > 0);
}

/// Default trait implementation should work identically to new().
#[test]
fn test_names_generator_default() {
    let ng = NameGenerator::default();
    assert!(ng.namespace_size() > 0);
}

/// Generate should produce a non-empty display name.
#[test]
fn test_names_generate_non_empty() {
    let ng = NameGenerator::new();
    let name = ng.generate();
    assert!(!name.display.is_empty());
    assert!(!name.adjective.is_empty());
    assert!(!name.plant.is_empty());
}

/// slug() should produce a branch-safe name (lowercase, hyphenated).
#[test]
fn test_names_slug_format() {
    let ng = NameGenerator::new();
    let name = ng.generate();
    let slug = name.slug();
    assert!(slug.chars().all(|c| c.is_ascii_lowercase() || c == '-'));
    assert!(!slug.starts_with('-'));
    assert!(!slug.ends_with('-'));
    assert!(
        slug.contains('-'),
        "Slug should have a hyphen separator: {slug}"
    );
}

/// slug() format is always "{adjective}-{plant}".
#[test]
fn test_names_slug_matches_parts() {
    let ng = NameGenerator::new();
    for _ in 0..20 {
        let name = ng.generate();
        let expected = format!("{}-{}", name.adjective, name.plant);
        assert_eq!(name.slug(), expected);
    }
}

/// generate_from_seed should be deterministic.
#[test]
fn test_names_generate_from_seed_deterministic() {
    let ng = NameGenerator::new();
    let n1 = ng.generate_from_seed(42);
    let n2 = ng.generate_from_seed(42);
    assert_eq!(n1.adjective, n2.adjective);
    assert_eq!(n1.plant, n2.plant);
    assert_eq!(n1.slug(), n2.slug());
}

/// Different seeds should (usually) produce different names.
#[test]
fn test_names_generate_from_seed_different_seeds() {
    let ng = NameGenerator::new();
    let n1 = ng.generate_from_seed(0);
    let n2 = ng.generate_from_seed(1);
    let n3 = ng.generate_from_seed(u64::MAX);
    // At least two of three should be different
    let all_same = n1.slug() == n2.slug() && n2.slug() == n3.slug();
    assert!(!all_same, "All three names are identical -- suspicious");
}

/// Seed of 0 should not cause issues.
#[test]
fn test_names_generate_from_seed_zero() {
    let ng = NameGenerator::new();
    let name = ng.generate_from_seed(0);
    assert!(!name.display.is_empty());
}

/// Seed of u64::MAX should not cause issues.
#[test]
fn test_names_generate_from_seed_max() {
    let ng = NameGenerator::new();
    let name = ng.generate_from_seed(u64::MAX);
    assert!(!name.display.is_empty());
}

/// namespace_size should equal len(ADJECTIVES) * len(PLANTS).
#[test]
fn test_names_namespace_size() {
    let ng = NameGenerator::new();
    let size = ng.namespace_size();
    let expected = ADJECTIVES.len() * PLANTS.len();
    assert_eq!(size, expected);
}

/// ADJECTIVES should all be lowercase ASCII.
#[test]
fn test_names_adjectives_ascii_lowercase() {
    for adj in ADJECTIVES {
        assert!(
            adj.chars().all(|c| c.is_ascii_lowercase()),
            "Adjective should be lowercase ASCII: {adj}"
        );
        assert!(!adj.is_empty(), "Empty adjective found");
    }
}

/// PLANTS should all be lowercase ASCII.
#[test]
fn test_names_plants_ascii_lowercase() {
    for plant in PLANTS {
        assert!(
            plant.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
            "Plant should be lowercase ASCII (may contain hyphens): {plant}"
        );
        assert!(!plant.is_empty(), "Empty plant found");
    }
}

/// Add an exact easter egg and verify it triggers with a deterministic seed.
#[test]
fn test_names_easter_egg_exact() {
    let mut ng = NameGenerator::new();
    let adj = ADJECTIVES[0];
    let plant = PLANTS[0];
    ng.add_egg(adj, plant, EasterEgg::Message("found it!".to_string()));

    // Seed 0 selects ADJECTIVES[0] + PLANTS[0], so this should trigger.
    let name = ng.generate_from_seed(0);
    assert!(
        name.easter_egg.is_some(),
        "Easter egg should trigger for seed 0 ({adj}, {plant})"
    );
}

/// Add a wildcard easter egg and verify it triggers deterministically.
#[test]
fn test_names_easter_egg_wildcard() {
    let mut ng = NameGenerator::new();
    let plant = PLANTS[0];
    ng.add_wildcard_egg("*", plant, EasterEgg::Message("any adj!".to_string()));
    // Seed 0 selects PLANTS[0], so wildcard on any adjective should trigger.
    let name = ng.generate_from_seed(0);
    assert!(
        name.easter_egg.is_some(),
        "Wildcard easter egg should trigger for plant '{plant}'"
    );
}

/// Generate many names and verify all are valid.
#[test]
fn test_names_generate_bulk_validity() {
    let ng = NameGenerator::new();
    for _ in 0..100 {
        let name = ng.generate();
        let slug = name.slug();
        assert!(!slug.is_empty());
        assert!(slug.contains('-'));
        assert!(slug.chars().all(|c| c.is_ascii_lowercase() || c == '-'));
    }
}

/// GeneratedName display should contain both adjective and plant.
#[test]
fn test_names_display_contains_parts() {
    let ng = NameGenerator::new();
    let name = ng.generate();
    // The display format might capitalize or use different separators,
    // but should contain both words in some form
    let display_lower = name.display.to_lowercase();
    assert!(
        display_lower.contains(&name.adjective) && display_lower.contains(&name.plant),
        "Display '{}' should contain adjective '{}' and plant '{}'",
        name.display,
        name.adjective,
        name.plant,
    );
}

/// No duplicate adjectives in the word list.
#[test]
fn test_names_adjectives_no_duplicates() {
    let mut seen = std::collections::HashSet::new();
    for adj in ADJECTIVES {
        assert!(seen.insert(adj), "Duplicate adjective: {adj}");
    }
}

/// No duplicate plants in the word list.
#[test]
fn test_names_plants_no_duplicates() {
    let mut seen = std::collections::HashSet::new();
    for plant in PLANTS {
        assert!(seen.insert(plant), "Duplicate plant: {plant}");
    }
}
