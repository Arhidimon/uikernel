/**
 * Copyright (с) 2015-present, SoftIndex LLC.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import React from 'react'; // eslint-disable-line no-unused-vars
import ReactDOM from 'react-dom';
import utils from '../../common/utils';
import ThrottleError from '../../common/ThrottleError';

const findDOMNode = ReactDOM.findDOMNode;

const ENTER_KEY = 13;
const ESCAPE_KEY = 27;

const GridEditorMixin = {

  /**
   * Display Editor in a table cell
   *
   * @param {HTMLElement} element     Cell DOM element
   * @param {string}      row         Row ID
   * @param {string}      column      Column ID
   * @private
   */
  _renderEditor: function (element, row, column) {
    const binds = this._getBindParam(column);
    const record = this._getRecord(row);
    let value = utils.at(record, binds);
    let focusDone = false;

    if (!Array.isArray(binds)) {
      value = value[0];
    }

    // Prevent recreate of the opened Editor
    if (this._isEditorVisible(row, column)) {
      return;
    }

    const editorContext = {
      updateField: (field, nextValue) => {
        const data = {};
        data[field] = nextValue;
        this._setRowChanges(row, data);
      }
    };

    const props = {
      onChange: (values) => {
        this._onChangeEditor(row, column, values, editorContext, element);
      },
      onFocus: () => {
        this._onFocusEditor(row, column);
      },
      onBlur: () => {
        // Remove Editor
        if (focusDone) {
          this._unmountEditor(element, row, column);
          this._onBlurEditor(row, column);
        }
      },
      onKeyUp: (e) => {
        if (focusDone && [ENTER_KEY, ESCAPE_KEY].includes(e.keyCode)) {
          this._unmountEditor(element, row, column);

          if (e.keyCode === ENTER_KEY) {
            this._onBlurEditor(row, column);
          }

          if (e.keyCode === ESCAPE_KEY) {
            if (this.state.data[row][column] !== value) {
              this._setRowChanges(row, {[column]: value});
              this._validateRow(row);
              return;
            }

            if (this.state.changes[row]) {
              delete this.state.changes[row][column];
            }

            this._updateField(row, column);
          }
        }
      },
      value: value
    };

    editorContext.props = props;

    // Display Editor
    const Component = this.props.cols[column].editor.call(editorContext, record, this);

    if (!Component) {
      return;
    }

    this.state.editor[`${row}_${column}`] = ReactDOM.render(Component, element, function () {
      element.classList.add('dgrid-input-wrapper');

      if (typeof this.focus === 'function') {
        this.focus();
      } else {
        findDOMNode(this).focus();
      }
      focusDone = true;
    });
  },

  _unmountEditor(element, row, column) {
    ReactDOM.unmountComponentAtNode(element);
    delete this.state.editor[`${row}_${column}`];
    element.classList.remove('dgrid-input-wrapper');
  },

  _onChangeEditor: function (row, column, values, editorContext, element) {
    let binds = this._getBindParam(column);

    values = utils.cloneDeep(utils.parseValueFromEvent(values));

    const record = this._getRecord(row);
    const context = utils.cloneDeep(editorContext);
    context.props.value = values;
    const Component = this.props.cols[column].editor.call(context, record, this);
    this.state.editor[`${row}_${column}`] = ReactDOM.render(Component, element);

    if (!Array.isArray(binds)) {
      binds = [binds];
      values = [values];
    }

    this._setRowChanges(row, utils.zipObject(binds, values));
  },

  _onFocusEditor: function (row, column) {
    if (!this.state.errors[row]) {
      return;
    }

    let binds = this._getBindParam(column);
    if (!Array.isArray(binds)) {
      binds = [binds];
    }

    binds.forEach(function (field) {
      this.state.errors[row].clearField(field);
    }, this);
    if (this.state.errors[row].isEmpty()) {
      delete this.state.errors[row];
    }
  },

  async _onBlurEditor(row, column) {
    this._updateField(row, column);
    try {
      await this._checkWarnings(row);
    } catch (e) {
      if (!(e instanceof ThrottleError)) {
        throw e;
      }
    }

    // TODO Deprecated prop realtime in v0.17
    if (this.props.autoSubmit || this.props.realtime) {
      if (this.props.realtime) {
        console.warn('Deprecated: Grid prop "realtime" renamed to "autoSubmit"');
      }
      this.save(this.props.onRealtimeSubmit);
    } else {
      this._validateRow(row);
    }
    if (this.props.onChange) {
      this.props.onChange(this.state.changes, this.state.data);
    }
  },

  _isEditorVisible: function (row, column) {
    return Boolean(this.state.editor[`${row}_${column}`]);
  }
};

export default GridEditorMixin;
