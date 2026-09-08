use crate::{llm, output, WhError};
use std::env;

/// ollama tags carry an explicit `:latest` that the model name usually
/// omits, and they name the same model.
fn same_model(a: &str, b: &str) -> bool {
    a.trim_end_matches(":latest") == b.trim_end_matches(":latest")
}

pub fn run() -> Result<(), WhError> {
    let getenv = |k: &str| env::var(k).ok();
    let provider = llm::choose(&getenv)?;
    let model = llm::model_for(&provider, &getenv);
    let ids = llm::list_models(&provider)?;
    if ids.is_empty() {
        return Err(WhError::Msg("provider returned no models".into()));
    }

    // the ids alone on stdout, so `wh models | grep` stays useful; what
    // is current goes to the status line beside them
    output::status(&format!(
        "{} · {} {} · current {model}",
        provider.name(),
        ids.len(),
        if ids.len() == 1 { "model" } else { "models" },
    ));
    for id in &ids {
        println!("{id}");
    }
    // the pinned default never follows latest, but a retired one should
    // not fail silently at request time (shared/prompts/provider.md)
    if !ids.iter().any(|id| same_model(id, &model)) {
        output::warn(&format!(
            "{} no longer lists {model}, set WH_MODEL to one of these",
            provider.name()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::same_model;

    #[test]
    fn an_ollama_tag_matches_the_bare_name() {
        assert!(same_model("llama3.2:latest", "llama3.2"));
        assert!(same_model("llama3.2", "llama3.2"));
        assert!(!same_model("llama3.2:1b", "llama3.2"));
        assert!(!same_model("qwen3:8b", "llama3.2"));
    }
}
