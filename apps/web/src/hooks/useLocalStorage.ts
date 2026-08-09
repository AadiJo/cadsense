import * as Schema from "effect/Schema";
import * as Record from "effect/Record";
import { useCallback, useEffect, useRef, useState } from "react";

const isomorphicLocalStorage: Storage =
  typeof window !== "undefined"
    ? window.localStorage
    : (function () {
        const store = new Map<string, string>();
        return {
          clear: () => store.clear(),
          getItem: (_) => store.get(_) ?? null,
          key: (_) => Record.keys(store).at(_) ?? null,
          get length() {
            return store.size;
          },
          removeItem: (_) => store.delete(_),
          setItem: (_, value) => store.set(_, value),
        };
      })();

const decode = <T, E>(schema: Schema.Codec<T, E>, value: string) => {
  const decodeJson = Schema.decodeSync(Schema.fromJsonString(schema));
  return decodeJson(value);
};

const encode = <T, E>(schema: Schema.Codec<T, E>, value: T) => {
  const encodeJson = Schema.encodeSync(Schema.fromJsonString(schema));
  return encodeJson(value);
};

export const getLocalStorageItem = <T, E>(key: string, schema: Schema.Codec<T, E>): T | null => {
  const item = isomorphicLocalStorage.getItem(key);
  return item ? decode(schema, item) : null;
};

export const setLocalStorageItem = <T, E>(key: string, value: T, schema: Schema.Codec<T, E>) => {
  const valueToSet = encode(schema, value);
  isomorphicLocalStorage.setItem(key, valueToSet);
};

export const removeLocalStorageItem = (key: string) => {
  isomorphicLocalStorage.removeItem(key);
};

const LOCAL_STORAGE_CHANGE_EVENT = "cadsense:local_storage_change";

interface LocalStorageChangeDetail {
  key: string;
}

function dispatchLocalStorageChange(key: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<LocalStorageChangeDetail>(LOCAL_STORAGE_CHANGE_EVENT, {
      detail: { key },
    }),
  );
}

export function persistLocalStorageUpdate<T, E>(
  key: string,
  previousValue: T,
  value: T | ((previous: T) => T),
  schema: Schema.Codec<T, E>,
): T {
  const nextValue =
    typeof value === "function" ? (value as (previous: T) => T)(previousValue) : value;
  if (nextValue === null) {
    removeLocalStorageItem(key);
  } else {
    setLocalStorageItem(key, nextValue, schema);
  }
  return nextValue;
}

export function useLocalStorage<T, E>(
  key: string,
  initialValue: T,
  schema: Schema.Codec<T, E>,
): [T, (value: T | ((val: T) => T)) => void] {
  // Get the initial value from localStorage or use the provided initialValue
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = getLocalStorageItem(key, schema);
      return item ?? initialValue;
    } catch (error) {
      console.error("[LOCALSTORAGE] Error:", error);
      return initialValue;
    }
  });
  const storedValueRef = useRef(storedValue);
  const replaceStoredValue = useCallback((nextValue: T) => {
    storedValueRef.current = nextValue;
    setStoredValue(nextValue);
  }, []);

  // Resolve and persist updates before handing the resulting value to React. State updater callbacks may
  // run more than once, so storage I/O cannot safely happen inside one.
  const setValue = useCallback(
    (value: T | ((val: T) => T)) => {
      try {
        const nextValue = persistLocalStorageUpdate(key, storedValueRef.current, value, schema);
        replaceStoredValue(nextValue);
        queueMicrotask(() => dispatchLocalStorageChange(key));
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    },
    [key, replaceStoredValue, schema],
  );

  const prevKeyRef = useRef(key);

  // Re-sync from localStorage when key changes
  useEffect(() => {
    if (prevKeyRef.current !== key) {
      prevKeyRef.current = key;
      try {
        const newValue = getLocalStorageItem(key, schema);
        replaceStoredValue(newValue ?? initialValue);
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    }
  }, [key, initialValue, replaceStoredValue, schema]);

  // Listen for storage events from other tabs AND custom events from the same tab
  useEffect(() => {
    const syncFromStorage = () => {
      try {
        const newValue = getLocalStorageItem(key, schema);
        replaceStoredValue(newValue ?? initialValue);
      } catch (error) {
        console.error("[LOCALSTORAGE] Error:", error);
      }
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === key) {
        syncFromStorage();
      }
    };

    const handleLocalChange = (event: CustomEvent<LocalStorageChangeDetail>) => {
      if (event.detail.key === key) {
        syncFromStorage();
      }
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener(LOCAL_STORAGE_CHANGE_EVENT, handleLocalChange as EventListener);
    };
  }, [key, initialValue, replaceStoredValue, schema]);

  return [storedValue, setValue];
}
