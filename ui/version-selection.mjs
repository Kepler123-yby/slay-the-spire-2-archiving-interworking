// A source must be explicitly chosen again after a scope change or refresh.
export class VersionSelection {
  constructor() {
    this.replace("", []);
  }
  replace(scope, versions) {
    this.scope = scope;
    this.versions = versions;
    this.id = "";
  }
  select(id) {
    this.id = this.versions.some((v) => v.id === id) ? id : "";
  }
  selected(scope) {
    return scope === this.scope
      ? this.versions.find((v) => v.id === this.id) || null
      : null;
  }
}
