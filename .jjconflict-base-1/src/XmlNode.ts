export type XmlNode = XmlElement | XmlText;

export type XmlElement = {
  kind: "element";
  tag: string;
  props: Record<string, string>;
  children: XmlNode[];
};

export type XmlText = {
  kind: "text";
  text: string;
};
