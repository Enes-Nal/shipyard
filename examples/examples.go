// Package examples carries the sample projects a box can make, so trying
// Terminal needs no repository of your own and no network: POST
// /v1/locations/new with "sample": "hello" writes examples/hello into a new
// git repository. The same files are in this repository, for anyone to
// read or clone.
package examples

import "embed"

// FS holds each sample in a folder of its own name.
//
//go:embed all:hello
var FS embed.FS

// Samples are the samples FS holds.
var Samples = []string{"hello"}
