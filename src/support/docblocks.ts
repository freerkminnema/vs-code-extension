import fs from "fs";
import { Eloquent } from "..";
import { internalVendorPath } from "./project";
import { indent } from "./util";

interface ClassBlock {
    namespace: string;
    className: string;
    blocks: string[];
}

// TODO: Chunk into several files if we have a lot of models?
// TODO: Check if doc block is already in model file, skip if it is
export const writeEloquentDocBlocks = (
    models: Eloquent.Models,
    builderMethods: Eloquent.BuilderMethod[],
) => {
    if (!models) {
        return;
    }

    const blocks: ClassBlock[] = Object.values(models).map((model) => {
        const pathParts = model.class.split("\\");
        const cls = pathParts.pop();

        return {
            namespace: pathParts.join("\\"),
            className: cls || "",
            blocks: getBlocks(model, cls || "", builderMethods),
        };
    });

    const namespaced: {
        [namespace: string]: ClassBlock[];
    } = {};

    blocks.forEach((block) => {
        if (!namespaced[block.namespace]) {
            namespaced[block.namespace] = [];
        }

        namespaced[block.namespace].push(block);
    });

    const finalContent = Object.entries(namespaced).map(
        ([namespace, blocks]) => {
            return [
                `namespace ${namespace} {`,
                ...blocks.map((block) => classToDocBlock(block, namespace)),
                "}",
            ].join("\n\n");
        },
    );

    finalContent.unshift("<?php");

    fs.writeFileSync(
        internalVendorPath("_model_helpers.php"),
        finalContent.join("\n\n"),
    );
};

const getBuilderReturnType = (
    method: Eloquent.BuilderMethod,
    className: string,
): string => {
    if (method.return === null) {
        return "mixed";
    }

    if (method.return === "never") {
        return "void";
    }

    if (["static", "self"].includes(method.return)) {
        return `\\Illuminate\\Database\\Eloquent\\Builder|${className}`;
    }

    const methodsThatReturnClassName = ["first","firstOrFail","sole"];

    const returnType = method.return
        .replace(
            "$this",
            `\\Illuminate\\Database\\Eloquent\\Builder|${className}`,
        )
        .replace("\\stdClass", `${className}`)
        .replace("object", `${className}`)
        .replace("TModel", className)
        .replace("\\TReturn", "mixed")
        .replace("TReturn", "mixed")
        .replace("\\TValue", methodsThatReturnClassName.includes(method.name) ? className : "mixed")
        .replace("TValue", "mixed");

    if (returnType.includes("|mixed") || returnType.includes("mixed|")) {
        // return "mixed";
    }

    return returnType;
};

const getBlocks = (
    model: Eloquent.Model,
    className: string,
    builderMethods: Eloquent.BuilderMethod[],
): string[] => {
    return model.attributes
        .map((attr) => getAttributeBlocks(attr, className))
        .concat(
            [...model.scopes, "newModelQuery", "newQuery", "query"].map(
                (method) => {
                    return `@method static \\Illuminate\\Database\\Eloquent\\Builder|${className} ${method}()`;
                },
            ),
        )
        .concat(model.relations.map((relation) => getRelationBlocks(relation)))
        .flat()
        .map((block) => ` * ${block}`)
        .sort((a, b) => {
            if (a.includes("@property-read")) {
                if (b.includes("@property")) {
                    return 1;
                }

                if (b.includes("@method")) {
                    return -1;
                }

                return 0;
            }

            if (a.includes("@property")) {
                return -1;
            }

            return 0;
        })
        .concat(
            builderMethods.map((method) => {
                return ` * @method static ${getBuilderReturnType(
                    method,
                    className,
                )} ${method.name}(${method.parameters
                    .map((p) => p.replace("\\TValue", "mixed"))
                    .join(", ")})`;
            }),
        );
};

const getRelationBlocks = (relation: Eloquent.Relation): string[] => {
    if (
        [
            "BelongsToMany",
            "HasMany",
            "HasManyThrough",
            "MorphMany",
            "MorphToMany",
        ].includes(relation.type)
    ) {
        return [
            `@property-read \\Illuminate\\Database\\Eloquent\\Collection<int, \\${relation.related}> $${relation.name}`,
            `@property-read int|null $${relation.name}_count`,
        ];
    }

    return [`@property-read \\${relation.related} $${relation.name}`];
};

const classToDocBlock = (block: ClassBlock, namespace: string) => {
    return [
        `/**`,
        ` * ${namespace}\\${block.className}`,
        " *",
        ...block.blocks,
        " * @mixin \\Illuminate\\Database\\Query\\Builder",
        " */",
        `class ${block.className} extends \\Illuminate\\Database\\Eloquent\\Model`,
        `{`,
        indent("//"),
        `}`,
    ]
        .map((b) => indent(b))
        .join("\n");
};

const getAttributeBlocks = (
    attr: Eloquent.Attribute,
    className: string,
): string[] => {
    const blocks: string[] = [];

    const propType = ["accessor", "attribute"].includes(attr.cast || "")
        ? "@property-read"
        : "@property";

    if (!attr.documented) {
        const type = getAttributeType(attr);

        blocks.push(`${propType} ${type} $${attr.name}`);
    }

    if (!["accessor", "attribute"].includes(attr.cast || "")) {
        blocks.push(
            `@method static \\Illuminate\\Database\\Eloquent\\Builder|${className} where${attr.title_case}($value)`,
        );
    }

    return blocks;
};

const getAttributeType = (attr: Eloquent.Attribute): string => {
    const type = getActualType(attr.cast, attr.type);

    if (type === "mixed") {
        return type;
    }

    return attr.nullable ? `${type}|null` : type;
};

const mapType = (cast: string|undefined, type: string): string => {
    const castMapping: Record<string, (string | RegExp)[]> = {
        string: [
            "hashed",
        ],
        "\\Illuminate\\Support\\Carbon": [
            "date",
            "datetime",
        ],
        "\\Illuminate\\Support\\Collection": [
            "encrypted:collection",
        ],
        object: [
            "encrypted:object",
        ],
        mixed: [
            "attribute",
            "accessor",
            "encrypted",
        ],
        array: [
            "json",
            "encrypted:json",
            "encrypted:array",
        ],
    };

    const rawTypeMapping: Record<string, (string | RegExp)[]> = {
        bool: [
            /boolean(\((0|1)\))?/,
            /tinyint( unsigned)?(\(\d+\))?/,
        ],
        string: [
            "date",
            "time",
            "uuid",
            /json(b)?/,
            /char\(\d+\)/,
            /varchar\(\d+\)/,
            /(long|medium)?text/,
            /character(\(\d+\))?/,
            /character varying(\(\d+\))?/,
            /time(stamp)? (with|without) time zone/,
            /time(stamp)?\(\d+\) (with|without) time zone/,
        ],
        float: [
            "real",
            "money",
            "double precision",
            /(double|decimal|numeric)(\(\d+\,\d+\))?/,
        ],
        int: [
            /(small|big)?int(eger)?( unsigned)?/,
            /(big)?serial/,
        ],
    };

    const findValueInMapping = (
        mapping: Record<string, (string | RegExp)[]>,
        value: string
    ): string | undefined => {
        for (const [newType, matches] of Object.entries(mapping)) {
            for (const match of matches) {
                if (match === value) {
                    return newType;
                }
                
                if (match instanceof RegExp && value.match(match)) {
                    return newType;
                }
            }
        }
        return undefined;
    };

    return (
        findValueInMapping(castMapping, cast ?? '') ||
        findValueInMapping(rawTypeMapping, type) ||
        type ||
        "mixed"
    );
};

const getActualType = (cast: string|undefined, type: string): string => {
    const finalType = mapType(cast, type);

    if (finalType.includes("\\") && !finalType.startsWith("\\")) {
        return `\\${finalType}`;
    }

    return finalType;
};
