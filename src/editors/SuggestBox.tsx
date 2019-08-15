/*
 * Copyright (с) 2015-present, SoftIndex LLC.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */
import toPromise from '../common/toPromise';
import {throttle, isEqual, findIndex, parents, omit, hasOwnProperty, unwrap} from '../common/utils';
import Portal from '../common/Portal';
import { findDOMNode } from 'react-dom';
import React from 'react';
import ThrottleError from '../common/ThrottleError';
const popupId = '__suggestBoxPopUp';
const classes = {
  option: '__suggestBoxPopUp-option',
  optionFocused: '__suggestBoxPopUp-option-focused',
  optionSelectable: '__suggestBoxPopUp-option-selectable',
  optionTypes: {
    group: '__suggestBoxPopUp-option-group',
    header: '__suggestBoxPopUp-option-header',
    subitem: '__suggestBoxPopUp-option-subitem',
    empty: '__suggestBoxPopUp-option-empty'
  },
  searchBlock: '__suggestBox-search',
  selectBtn: '__suggestBox-select-btn',
  arrow: '__suggestBox-arrow',
  up: '__suggestBox-up'
};
const TAB_KEY = 9;
const ENTER_KEY = 13;
const ESCAPE_KEY = 27;
const ARROW_UP_KEY = 38;
const ARROW_DOWN_KEY = 40;
const MIN_POPUP_HEIGHT = 100;

interface TModel {
  read: (...args: any[]) => any,
  getLabel: (...args: any[]) => any
}

type SuggestBoxEditorProps = {
  disabled?: boolean,
  model: TModel,
  onChange: (...args: any[]) => any,
  onLabelChange?: (...args: any[]) => any,
  onMetadataChange?: (...args: any[]) => any,
  value?: any,
  defaultLabel?: string,
  label?: string,
  notFoundElement?: JSX.Element,
  loadingElement?: JSX.Element,
  onFocus?: (...args: any[]) => any,
  withEmptyOption?: boolean
};
type SuggestBoxEditorState = {
  label: string,
  lastValidLabel: string,
  options: any[],
  selectedOptionKey: number | null,
  isOpened: boolean,
  popupStyles: {[index: string]: any},
  loading: boolean
};
class SuggestBoxEditor extends React.Component<
  SuggestBoxEditorProps,
  SuggestBoxEditorState
> {
  static defaultProps = {
    disabled: false,
    notFoundElement: <div>Nothing found</div>,
    loadingElement: <div>Loading...</div>,
    value: null,
    withEmptyOption: false
  };
  private _isMounted: boolean | undefined;
  private input: React.RefObject<HTMLInputElement>;
  constructor(props: SuggestBoxEditorProps) {
    super(props);
    this._loadData = throttle(this._loadData);
    this.state = {
      isOpened: false,
      loading: false,
      options: [],
      selectedOptionKey: null,
      lastValidLabel: '',
      label: '',
      popupStyles: {}
    };
    this.input = React.createRef();
    this._onInputFocus = this._onInputFocus.bind(this);
    this._onInputKeyDown = this._onInputKeyDown.bind(this);
    this._onInputValueChange = this._onInputValueChange.bind(this);
    this._focusOption = this._focusOption.bind(this);
    this._onDocumentMouseDown = this._onDocumentMouseDown.bind(this);
    this._onDocumentMouseScroll = this._onDocumentMouseScroll.bind(this);
    this._toggleList = this._toggleList.bind(this);
    this._openList = this._openList.bind(this);
  }
  componentDidMount() {
    this._isMounted = true;
    if (this.props.defaultLabel) {
      this._setLabelTo(this.props.defaultLabel, true);
    } else if (hasOwnProperty(this.props, 'label')) {
      this._setLabelTo(this.props.label, true);
    } else {
      this._getLabelFromModel(this.props.model, this.props.value);
    }
  }
  componentWillUnmount() {
    this._isMounted = false;
  }
  shouldComponentUpdate(nextProps: SuggestBoxEditorProps, nextState: SuggestBoxEditorState) {
    return (
      this.state !== nextState ||
      !isEqual(this.props.value, nextProps.value) ||
      this.props.disabled !== nextProps.disabled
    );
  }
  componentWillReceiveProps(nextProps: SuggestBoxEditorProps) {
    if (!isEqual(this.props.value, nextProps.value)) {
      if (!hasOwnProperty(this.props, 'label')) {
        this._getLabelFromModel(nextProps.model, nextProps.value);
      }
    }
    if (this.props.label !== nextProps.label) {
      this._setLabelTo(nextProps.label, true);
    }
  }
  _getOptionLabel(option: { label: any[]; }) {
    return Array.isArray(option.label)
      ? option.label[option.label.length - 1]
      : option.label;
  }
  _setLabelTo(label: string | null | undefined, markAsValid?: boolean) {
    if (label === null || label === undefined) {
      label = '';
    }
    this.setState({
      label: label,
      lastValidLabel: markAsValid ? label : this.state.lastValidLabel
    });
  }
  _getLabelFromModel(model: TModel, id: any) {
    if (id === null || id === undefined) {
      return this._setLabelTo('', true);
    }
    model
      .getLabel(id)
      .then((label: string) => {
        if (!this._isMounted) {
          return;
        }
        this._setLabelTo(label, true);
      })
      .catch((err: any) => {
        if (err) {
          console.error(err);
          throw err;
        }
      });
  }
  async _updateList(searchPattern?: string) {
    let options;
    try {
      options = await this._loadData(searchPattern);
    } catch (e) {
      if (!(e instanceof ThrottleError)) {
        throw e;
      }
      return;
    }
    if (options.length && this.props.withEmptyOption) {
      options.unshift({
        id: null,
        label: '\u00A0' // Use this symbol for save line height
      });
    }
    if (this._isMounted) {
      await this.setState({
        options,
        selectedOptionKey: null,
        loading: false
      });
    }
    const content = document.querySelector(
      `${popupId} .__suggestBoxPopUp-content`
    );
    if (content) {
      content.style = {
        bottom: 'auto',
        position: 'static'
      };
    }
    this._scrollListTo();
  }
  _loadData(searchPattern?: string) {
    return this.props.model.read(searchPattern || '');
  }
  async _openList(searchPattern?: string, focusFirstOption = false) {
    if (this.props.disabled || this.state.isOpened) {
      return;
    }
    const popupStyles = this._getComputedPopupStyles();
    if (!popupStyles) {
      return;
    }
    await toPromise(this.setState.bind(this), true)({
      isOpened: true,
      loading: true,
      popupStyles
    });
    ((findDOMNode(this.input.current) as HTMLInputElement)).select();
    await this._updateList(searchPattern); // TODO Handle errors
    if (!this.state.options.length) {
      return;
    }
    if (focusFirstOption) {
      const key = this.state.options[0].type !== 'group' ? 0 : 1;
      await this._focusOption(key, true);
      return;
    }
    const selectedOptionKey = findIndex(this.state.options, option => {
      return isEqual(option.id, this.props.value);
    });
    if (selectedOptionKey !== -1) {
      this._focusOptionAndScrollIntoView(Number(selectedOptionKey));
    }
  }
  async _onInputFocus(e: React.FocusEvent<HTMLInputElement>) {
    await this._openList();
    if (!this._isMounted) {
      return;
    }
    ((findDOMNode(this.input.current) as HTMLInputElement)).select();
    if (this.props.onFocus) {
      this.props.onFocus(e);
    }
  }
  _closeList(shouldBlur?: boolean) {
    if (shouldBlur) {
      ((findDOMNode(this.input.current) as HTMLInputElement)).blur();
    }
    if (!this.state.isOpened || !this._isMounted) {
      return;
    }
    this.setState({
      options: [],
      selectedOptionKey: null,
      isOpened: false
    });
  }
  async _toggleList() {
    if (this.state.isOpened) {
      this._closeList();
    } else {
      await this._openList();
    }
  }
  _selectOption(option: any) {
    option = option || {
      id: null,
      label: '',
      metadata: {}
    };
    this.props.onChange(option.id, option);
    if (this.props.onLabelChange) {
      this.props.onLabelChange(option.label);
    }
    if (this.props.onMetadataChange) {
      this.props.onMetadataChange(option.metadata);
    }
    ((findDOMNode(this.input.current) as HTMLInputElement)).select();
  }
  async _focusOption(key: number, shouldSetLabel: boolean = false) {
    if (shouldSetLabel) {
      this._setLabelTo(this.state.options[key].label);
    }
    if (this.state.isOpened) {
      this._focusOptionAndScrollIntoView(key);
    } else {
      await this._openList();
      this._focusOptionAndScrollIntoView(key);
    }
  }
  _focusOptionAndScrollIntoView(key: number) {
    // @ts-ignore
    this.state.selectedOptionKey = key;
    const focusedItems = document.querySelector(`.${classes.optionFocused}`);
    const currentItem = document.querySelector(
      `.${classes.option}[data-key="${key}"]`
    );
    if (focusedItems) {
      focusedItems.classList.remove(classes.optionFocused);
    }
    if (currentItem) {
      currentItem.classList.add(classes.optionFocused);
    }
    const domOption = document.querySelectorAll(
      `#${popupId} li[data-key="${key}"]`
    )[0];
    this._scrollListTo(domOption);
  }
  _focusNextOption() {
    if (!this.state.options.length) {
      return;
    }
    if (this.state.selectedOptionKey === null) {
      // @ts-ignore
      this.state.selectedOptionKey = 0;
      return this._focusOption(this.state.selectedOptionKey, true);
    }
    let key;
    for (
      key = this.state.selectedOptionKey + 1;
      key < this.state.options.length;
      key++
    ) {
      if (this.state.options[key].id) {
        return this._focusOption(key, true);
      }
    }
    for (key = 0; key < this.state.selectedOptionKey + 1; key++) {
      if (this.state.options[key].id) {
        return this._focusOption(key, true);
      }
    }
  }
  _focusPrevOption() {
    if (this.state.selectedOptionKey === null) {
      // @ts-ignore
      this.state.selectedOptionKey = 0;
      return this._focusOption(this.state.selectedOptionKey);
    }
    let key;
    for (key = this.state.selectedOptionKey - 1; key >= 0; key--) {
      if (this.state.options[key].id) {
        return this._focusOption(key, true);
      }
    }
    for (
      key = this.state.options.length - 1;
      key > this.state.selectedOptionKey - 1;
      key--
    ) {
      if (this.state.options[key].id) {
        return this._focusOption(key, true);
      }
    }
  }
  _scrollListTo(target?: HTMLElement) {
    const container = document.querySelector(`#${popupId}:first-child`);
    if (!container) {
      return;
    }
    if (!target) {
      container.scrollTop = 0;
      return;
    }
    if (
      target.offsetTop - container.scrollTop >=
      container.clientHeight - target.clientHeight
    ) {
      container.scrollTop =
        target.offsetTop - container.clientHeight + target.clientHeight;
    } else if (target.offsetTop - container.scrollTop < 0) {
      container.scrollTop = target.offsetTop;
    }
  }

  _isParentOf(child: (Node & ParentNode) | null) {
    while (child) {
      child = child.parentNode;
      if (child === findDOMNode(this)) {
        return true;
      }
    }
    return false;
  }
  _onDocumentMouseDown(e: React.MouseEvent<Portal>, isOwner: boolean) {
    if (e.button !== 0) {
      return;
    }
    let target = e.target as HTMLElement;
    if (isOwner) {
      if (!target.classList.contains(classes.option)) {
        target = target.parentNode as HTMLElement;
      }
      if (
        target.classList.contains(classes.optionSelectable) &&
        this.state.isOpened
      ) {
        this._selectOption(this.state.options[Number(unwrap(target.getAttribute('data-key')))]);
        this._closeList(true);
      }
    } else {
      // q where to test
      if (!parents(target, `.${classes.searchBlock}`).length) {
        if (!((findDOMNode(this.input.current) as HTMLInputElement)).value) {
          this._selectOption(null);
        } else {
          this._setLabelTo(this.state.lastValidLabel);
        }
      }
      if (!this._isParentOf(e.target as (Node & ParentNode))) {
        this._closeList(true);
      }
    }
  }
  _onDocumentMouseScroll(e: React.MouseEvent<HTMLInputElement>, isOwner: boolean) {
    if (!isOwner && this.state.isOpened) {
      const popupStyles = this._getComputedPopupStyles();
      if (popupStyles) {
        this.setState({
          popupStyles: this._getComputedPopupStyles()
        });
      } else {
        this._setLabelTo(this.state.lastValidLabel);
        this._closeList(true);
      }
    }
  }
  _onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (this.props.disabled) {
      return;
    }
    switch (e.keyCode) {
    case ARROW_DOWN_KEY:
      e.preventDefault();
      if (!this.state.isOpened) {
        return this._openList('', true);
      }
      this._focusNextOption();
      break;
    case ARROW_UP_KEY:
      e.preventDefault();
      if (!this.state.isOpened) {
        return this._openList();
      }
      this._focusPrevOption();
      break;
    case ENTER_KEY:
      e.preventDefault();
      if (this.state.selectedOptionKey === null) {
        this._selectOption(null);
      } else {
        this._selectOption(this.state.options[this.state.selectedOptionKey]);
      }
      this._closeList();
      break;
    case TAB_KEY:
    case ESCAPE_KEY:
      if (e.keyCode === ESCAPE_KEY) {
        e.preventDefault();
      }
      if (!e.currentTarget.value || !this.props.value) {
        this._setLabelTo('');
        this._selectOption(null);
      } else {
        this._setLabelTo(this.state.lastValidLabel);
      }
      this._closeList();
      break;
    }
  }
  async _onInputValueChange(e: React.ChangeEvent<HTMLInputElement>) {
    this._setLabelTo(e.target.value);
    if (this.state.isOpened) {
      await this._updateList(e.target.value);
    } else {
      await this._openList(e.target.value);
    }
  }
  _getComputedPopupStyles() {
    const inputStyles = window.getComputedStyle(((findDOMNode(this.input.current) as HTMLInputElement)));
    const popupStyle: React.CSSProperties = {};
    const inputOffset = ((findDOMNode(this.input.current) as HTMLInputElement)).getBoundingClientRect();
    const inputWidth = unwrap(inputStyles.width);
    const inputHeight = parseInt(unwrap(inputStyles.height));
    if (
      inputOffset.top + inputHeight <= 0 ||
      inputOffset.top >= window.innerHeight
    ) {
      return null;
    }
    const offsetTop = inputOffset.top + inputHeight;
    const offsetLeft = inputOffset.left;
    if (typeof window !== 'undefined') {
      const availableSpace = window.innerHeight - offsetTop;
      if (availableSpace < MIN_POPUP_HEIGHT) {
        popupStyle.maxHeight = inputOffset.top;
        popupStyle.bottom = -inputOffset.top;
      } else {
        popupStyle.maxHeight = availableSpace;
        popupStyle.top = offsetTop;
      }
    }
    popupStyle.minWidth = inputWidth;
    popupStyle.left = offsetLeft;
    return popupStyle;
  }
  focus() {
    ((findDOMNode(this.input.current) as HTMLInputElement)).focus();
  }
  render() {
    const arrowClasses = [classes.arrow];
    let options;
    let optionsPopup = null;
    if (this.state.isOpened) {
      arrowClasses.push(classes.up);
      if (this.state.loading) {
        options = (
          <li className={[classes.option, classes.optionTypes.empty].join(' ')}>
            {this.props.loadingElement}
          </li>
        );
      } else {
        if (!this.state.options.length) {
          options = (
            <li
              className={[classes.option, classes.optionTypes.empty].join(' ')}
            >
              {this.props.notFoundElement}
            </li>
          );
        } else {
          options = this.state.options.map((option, key) => {
            const optionClassNames = [classes.option];
            if (key === this.state.selectedOptionKey) {
              optionClassNames.push(classes.optionFocused);
            }
            if (option.id !== undefined) {
              optionClassNames.push(classes.optionSelectable);
            }
            if (option.type) {
              optionClassNames.push(
                classes.optionTypes[option.type] || option.type
              );
            }
            return (
              <li
                key={key}
                data-key={key}
                onMouseOver={async () => {
                  this._focusOption(key);
                }}
                className={optionClassNames.join(' ')}
              >
                {Array.isArray(option.label) ? (
                  option.label.map((label: string, columnKey: string) => (
                    <div key={columnKey}>{label}</div>
                  ))
                ) : (
                  <div>{option.label}</div>
                )}
              </li>
            );
          });
        }
      }
      optionsPopup = (
        <Portal
          id={popupId}
          style={this.state.popupStyles}
          onDocumentMouseDown={this._onDocumentMouseDown}
          onDocumentMouseScroll={this._onDocumentMouseScroll}
          className="__suggestBoxPopUp"
        >
          <div className="__suggestBoxPopUp-content">
            <ul>{options}</ul>
          </div>
        </Portal>
      );
    }
    return (
      <div className="__suggestBox">
        <div className={classes.searchBlock}>
          <input
            {...omit(this.props, [
              'model',
              'value',
              'onChange',
              'onLabelChange',
              'onFocus',
              'select',
              'notFoundElement',
              'loadingElement',
              'defaultLabel',
              'onMetadataChange',
              'withEmptyOption'
            ])}
            ref={this.input}
            type="text"
            onClick={this._openList}
            onFocus={this._onInputFocus}
            onKeyDown={this._onInputKeyDown}
            onChange={this._onInputValueChange}
            value={this.state.label}
          />
          <div onClick={this._toggleList} className={classes.selectBtn}>
            <div className={arrowClasses.join(' ')} />
          </div>
        </div>
        {optionsPopup}
      </div>
    );
  }
}
export default SuggestBoxEditor;