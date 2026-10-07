// Thin wrapper over Firestore so the app code stays storage-agnostic:
// db.doc(path).set/delete/onSnapshot and db.collection(path).orderBy().limit().onSnapshot/add.
import {
  doc, collection, query, orderBy, limit, onSnapshot, setDoc, deleteDoc, addDoc, getDoc,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const wrap = (s) => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: s.metadata });

export function makeStore(fs) {
  function collectionRef(path, constraints = []) {
    const ref = collection(fs, path);
    return {
      orderBy: (field, dir) => collectionRef(path, [...constraints, orderBy(field, dir)]),
      limit: (n) => collectionRef(path, [...constraints, limit(n)]),
      add: (data) => addDoc(ref, data),
      onSnapshot: (next, error) => onSnapshot(query(ref, ...constraints), (q) => next({ docs: q.docs.map(wrap), size: q.size, empty: q.empty }), error),
    };
  }
  return {
    doc(path) {
      const ref = doc(fs, path);
      return {
        get: async () => wrap(await getDoc(ref)),
        set: (data) => setDoc(ref, data),
        delete: () => deleteDoc(ref),
        onSnapshot: (next, error) => onSnapshot(ref, (s) => next(wrap(s)), error),
      };
    },
    collection: (path) => collectionRef(path),
  };
}
