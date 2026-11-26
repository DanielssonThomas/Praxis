use reqwest::header::HeaderValue;
use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

#[derive(Default)]
pub(crate) struct OperatorSessions {
    credentials: Mutex<HashMap<&'static str, HeaderValue>>,
}

impl OperatorSessions {
    pub(crate) fn authorization(raw: &str) -> Option<HeaderValue> {
        let token = raw.trim();
        if !(32..=256).contains(&token.len())
            || !token.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-')
            })
        {
            return None;
        }
        let mut header = HeaderValue::from_str(&format!("Bearer {token}")).ok()?;
        header.set_sensitive(true);
        Some(header)
    }

    pub(crate) fn get(&self, scope: &'static str) -> Option<HeaderValue> {
        self.credentials
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(scope)
            .cloned()
    }

    pub(crate) fn remember(&self, scope: &'static str, authorization: HeaderValue) {
        self.credentials
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(scope, authorization);
    }

    pub(crate) fn clear(&self, scope: &'static str) {
        self.credentials
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(scope);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_are_sensitive_and_scoped_until_cleared() {
        assert!(OperatorSessions::authorization("too short").is_none());
        assert!(OperatorSessions::authorization(&("a".repeat(32) + "\nextra")).is_none());
        let authorization = OperatorSessions::authorization(&"a".repeat(32)).unwrap();
        assert!(authorization.is_sensitive());

        let sessions = OperatorSessions::default();
        sessions.remember("fixture", authorization.clone());
        assert_eq!(sessions.get("fixture"), Some(authorization));
        assert!(sessions.get("other").is_none());
        sessions.clear("fixture");
        assert!(sessions.get("fixture").is_none());
    }
}
