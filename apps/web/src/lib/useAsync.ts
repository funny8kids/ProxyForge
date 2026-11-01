import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * 极简数据获取：足够覆盖控制台的读多写少场景。
 * 显式暴露 error 而不是静默吞掉 —— 控制台里"空白页"是最难排查的故障。
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    fn()
      .then((res) => {
        if (alive) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const msg =
          err instanceof ApiError
            ? `${err.problem?.code ?? 'ERROR'}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        setError(msg);
        setLoading(false);
      });

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload };
}
