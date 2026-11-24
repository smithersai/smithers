/** The transactional Durable Object storage surface the worker's objects use. */
export interface Transaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}
export interface State {
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    transaction<T>(callback: (txn: Transaction) => Promise<T>): Promise<T>;
    /** Schedule `alarm()`. An object holds one alarm, so a later call replaces an earlier one. */
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
    deleteAll(): Promise<void>;
  };
}
